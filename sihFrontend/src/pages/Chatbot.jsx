import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  Send,
  RefreshCw,
  ShieldCheck,
  BookOpen,
  Bot,
  User,
  Info,
  Mic,
  MicOff,
  Loader2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import PageTransition from '../components/PageTransition';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { useAuth } from '../context/AuthContext';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function cleanTextForSpeech(markdown) {
  if (!markdown) return '';
  let text = markdown;

  // 1. Remove Markdown tables (lines starting and ending with | or containing multiple |)
  text = text.replace(/^\|.*\|.*$/gm, '');
  
  // 2. Remove Markdown links and images: [text](url) -> text
  text = text.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1');
  
  // 3. Remove bare URLs
  text = text.replace(/https?:\/\/[^\s]+/g, '');
  
  // 4. Remove Markdown formatting symbols (*, _, ~, `, #, >)
  text = text.replace(/[*_~`>#]+/g, '');
  
  // 5. Replace newlines with periods so the TTS pauses, and condense spaces
  text = text.replace(/\n+/g, '. ');
  text = text.replace(/\s{2,}/g, ' ');

  return text.trim();
}

/**
 * Pick the best MIME type that MediaRecorder supports in this browser.
 * Falls back gracefully so we always get a recording.
 */
function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
    '',  // browser default — always accepted
  ];
  for (const type of candidates) {
    if (type === '' || MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export default function Chatbot() {
  const navigate = useNavigate();
  const { isAuthenticated, user, setPendingChatbotAccess } = useAuth();
  
  const [messages, setMessages] = useState([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  // ── Voice recording state ──────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // ── TTS (Text-to-Speech) state ──────────────────────────────
  const [activeAudioId, setActiveAudioId] = useState(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Redirect to login if user is not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      setPendingChatbotAccess(true);
      navigate('/login', { replace: true });
    }
  }, [isAuthenticated, navigate, setPendingChatbotAccess]);

  // Auto scroll to bottom of chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, isLoading]);

  if (!isAuthenticated) {
    return null;
  }

  const handleSend = async (queryToSend) => {
    const text = queryToSend || inputQuery;
    if (!text.trim() || isLoading) return;

    // Add user message immediately
    const userMsg = { id: Date.now(), sender: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text }),
      });

      const data = await res.json();
      const botMsgId = Date.now() + 1;

      if (!res.ok) {
        // Express returned an error (e.g. FastAPI is down)
        const botMsg = {
          id: botMsgId,
          sender: 'bot',
          answer: data.error || 'Something went wrong. Please try again.',
          sources: [],
        };
        setMessages((prev) => [...prev, botMsg]);
      } else {
        // FastAPI returns { answer: string, sources: string[] }
        const botMsg = {
          id: botMsgId,
          sender: 'bot',
          answer: data.answer || 'No answer returned.',
          sources: Array.isArray(data.sources) ? data.sources : [],
        };
        setMessages((prev) => [...prev, botMsg]);
      }
    } catch (err) {
      const botMsgId = Date.now() + 1;
      const botMsg = {
        id: botMsgId,
        sender: 'bot',
        answer: 'Could not reach the server. Please make sure both the API server and AI engine are running.',
        sources: [],
      };
      setMessages((prev) => [...prev, botMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setInputQuery('');
    setIsLoading(false);
    setVoiceError('');
  };

  // ─────────────────────────────────────────────────────────────
  // Voice recording — START
  // ─────────────────────────────────────────────────────────────
  const startRecording = async () => {
    setVoiceError('');
    if (isLoading || isRecording || isTranscribing) return;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setVoiceError('Microphone permission denied. Please allow access in your browser settings.');
      } else if (err.name === 'NotFoundError') {
        setVoiceError('No microphone found. Please connect a microphone and try again.');
      } else {
        setVoiceError('Could not access microphone. Please try again.');
      }
      return;
    }

    audioChunksRef.current = [];
    const mimeType = getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      recorder = new MediaRecorder(stream); // fallback: browser default
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data);
      }
    };

    recorder.onstop = async () => {
      // Release the mic indicator light immediately
      stream.getTracks().forEach((t) => t.stop());

      const chunks = audioChunksRef.current;
      if (chunks.length === 0) {
        setVoiceError('No audio was recorded. Please try again.');
        setIsTranscribing(false);
        return;
      }

      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });

      // Guard: reject empty / silent recordings (< 1 KB)
      if (blob.size < 1024) {
        setVoiceError('Recording too short. Please hold the button and speak clearly.');
        setIsTranscribing(false);
        return;
      }

      await transcribeAudio(blob, recorder.mimeType || 'audio/webm');
    };

    recorder.start(250); // collect chunks every 250 ms
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  };

  // ─────────────────────────────────────────────────────────────
  // Voice recording — STOP
  // ─────────────────────────────────────────────────────────────
  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecording) return;
    setIsRecording(false);
    setIsTranscribing(true);
    try {
      mediaRecorderRef.current.stop(); // triggers onstop above
    } catch {
      setIsTranscribing(false);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Send audio blob → /api/transcribe → auto-submit query
  // ─────────────────────────────────────────────────────────────
  const transcribeAudio = async (blob, mimeType) => {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `voice_query.${ext}`;

    const formData = new FormData();
    formData.append('audio', blob, filename);

    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
        // Do NOT manually set Content-Type — browser injects the multipart boundary
      });

      const data = await res.json();

      if (!res.ok) {
        setVoiceError(data.error || 'Transcription failed. Please try again.');
        return;
      }

      const transcript = (data.transcript || '').trim();
      if (!transcript) {
        setVoiceError('Could not understand the audio. Please speak clearly and try again.');
        return;
      }

      // Populate input, then auto-send after state commits
      setInputQuery(transcript);
      setTimeout(() => handleSend(transcript), 50);
    } catch {
      setVoiceError('Could not reach the transcription server. Please ensure both servers are running.');
    } finally {
      setIsTranscribing(false);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Text-to-Speech (TTS) logic
  // ─────────────────────────────────────────────────────────────
  const playTTS = async (messageId, text) => {
    // If clicking the same message that's currently playing, stop it
    if (activeAudioId === messageId && isSpeaking) {
      stopTTS();
      return;
    }

    // Stop any existing audio first
    stopTTS();

    if (!text || !text.trim()) {
      setVoiceError("No readable words found to speak in this response.");
      return;
    }

    setActiveAudioId(messageId);
    setIsSpeaking(true);
    setVoiceError('');

    abortControllerRef.current = new AbortController();

    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) {
        throw new Error('TTS failed');
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => {
        setIsSpeaking(false);
        setActiveAudioId(null);
        URL.revokeObjectURL(url);
      };

      audio.onerror = () => {
        setVoiceError('Could not play the audio response.');
        setIsSpeaking(false);
        setActiveAudioId(null);
        URL.revokeObjectURL(url);
      };

      await audio.play();
    } catch (err) {
      if (err.name === 'AbortError') {
        // User clicked stop before fetch finished; ignore quietly.
        return;
      }
      setVoiceError('Could not generate speech response.');
      setIsSpeaking(false);
      setActiveAudioId(null);
    }
  };

  const stopTTS = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }
    
    setIsSpeaking(false);
    setActiveAudioId(null);
  };

  // ── Derived UI helpers ────────────────────────────────────────
  const micBusy = isRecording || isTranscribing;
  const micDisabled = isLoading;
  const micLabel = isTranscribing
    ? 'Transcribing…'
    : isRecording
    ? 'Stop Recording'
    : 'Voice Input';


  return (
    <PageTransition className="h-full flex flex-col flex-1 min-h-0">
      {/* Full-viewport column — no page scroll, chat fills remaining height */}
      <div className="flex flex-col flex-1 min-h-0 pt-28 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto w-full gap-4 pb-4">

        {/* TOP BAR / HEADER
        <div className="liquid-glass-panel p-4 sm:p-5 border-saffron/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-2xl bg-saffron/20 border border-saffron/40 flex items-center justify-center text-saffron shrink-0">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2.5">
                <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
                  Jagruk Swadesh AI Chatbot
                </h1>
                <span className="px-2.5 py-0.5 rounded-full bg-saffron/20 border border-saffron/40 text-[10px] font-black text-saffron uppercase tracking-wider">
                  BIS Intelligence Engine
                </span>
              </div>
              <p className="text-xs text-ivory-muted font-medium mt-0.5">
                Source-backed answers for Indian Standards, certification, testing & consumer guidelines
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3 self-end sm:self-auto">
            {messages.length > 0 && (
              <button
                onClick={handleNewChat}
                className="px-3.5 py-2 rounded-xl text-xs font-bold text-ivory-dim hover:text-white bg-white/10 hover:bg-white/20 border border-white/15 transition-all flex items-center space-x-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>New Conversation</span>
              </button>
            )}
            <div className="hidden md:flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-forest-dark/80 border border-emerald-400/30 text-xs font-semibold text-emerald-300">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>{user?.name || 'Authenticated User'}</span>
            </div>
          </div>
        </div> */}

        {/* CHAT MAIN PANEL — flex-1 min-h-0 fills all remaining space */}
        <div className="liquid-glass-panel border-white/15 flex-1 min-h-0 flex flex-col overflow-hidden relative shadow-2xl">

          {/* MESSAGES SCROLL AREA */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 scroll-smooth">
            
            {/* EMPTY STATE */}
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto space-y-4">
                {/* <div className="w-16 h-16 rounded-2xl bg-amber-400/20 border border-amber-400/50 flex items-center justify-center text-amber-300 shadow-lg">
                  <Sparkles className="w-8 h-8" />
                </div> */}
                <div className="space-y-2">
                  <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                    Ask about Indian Standards & BIS
                  </h2>
                  {/* <p className="text-xs sm:text-sm text-ivory-muted font-medium leading-relaxed">
                    Type any query about Indian Standards, ISI mark compliance, product certification, or testing requirements.
                  </p> */}
                </div>
              </div>
            )}

            {/* CONVERSATION HISTORY */}
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={`flex gap-3.5 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.sender === 'bot' && (
                  <div className="w-9 h-9 rounded-2xl bg-saffron/25 border border-saffron/50 flex items-center justify-center text-saffron-light shrink-0 mt-1 shadow-md">
                    <Bot className="w-5 h-5" />
                  </div>
                )}

                <div className={`max-w-[88%] sm:max-w-[80%] rounded-2xl p-4 sm:p-5 space-y-3.5 ${
                  msg.sender === 'user'
                    ? 'bg-gradient-to-r from-saffron/30 to-amber-500/30 border border-saffron/50 text-white shadow-md'
                    : 'bg-nature-950/90 border border-white/20 text-white shadow-lg backdrop-blur-xl'
                }`}>
                  {msg.sender === 'user' ? (
                    <p className="text-sm font-semibold leading-relaxed text-white">
                      {msg.text}
                    </p>
                  ) : (
                    <div className="space-y-4 text-xs sm:text-sm font-medium">
                      
                      {/* ANSWER — rendered as rich markdown */}
                      <div className="space-y-1.5 relative">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-black uppercase tracking-wider text-saffron block">
                            Official Guidance Answer
                          </span>
                          
                          {/* TTS BUTTON */}
                          <button
                            onClick={() => playTTS(msg.id, cleanTextForSpeech(msg.answer))}
                            title={activeAudioId === msg.id && isSpeaking ? "Stop Speaking" : "Listen to Answer"}
                            className={`p-1.5 rounded-lg transition-colors flex items-center justify-center ${
                              activeAudioId === msg.id && isSpeaking
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'bg-white/5 text-ivory-dim hover:text-white hover:bg-white/15'
                            }`}
                          >
                            {activeAudioId === msg.id && isSpeaking ? (
                              <VolumeX className="w-3.5 h-3.5 animate-pulse" />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                        
                        <div className="text-ivory leading-relaxed">
                          <MarkdownRenderer content={msg.answer} />
                        </div>
                      </div>

                      {/* SOURCE REFERENCES */}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="pt-3 border-t border-white/15 space-y-2">
                          <div className="flex items-center space-x-1.5 text-xs font-extrabold text-amber-300">
                            <BookOpen className="w-3.5 h-3.5" />
                            <span>Verified Reference Sources</span>
                          </div>
                          <ul className="space-y-1.5 pl-1">
                            {msg.sources.map((src, i) => (
                              <li key={i} className="text-xs text-ivory-dim font-medium flex items-start space-x-2">
                                <span className="text-saffron font-bold">•</span>
                                <span>{src}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                    </div>
                  )}
                </div>

                {msg.sender === 'user' && (
                  <div className="w-9 h-9 rounded-2xl bg-white/15 border border-white/30 flex items-center justify-center text-white shrink-0 mt-1 shadow-md">
                    <User className="w-5 h-5" />
                  </div>
                )}
              </motion.div>
            ))}

            {/* TYPING / LOADING INDICATOR */}
            {isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center space-x-3 text-ivory-dim"
              >
                <div className="w-9 h-9 rounded-2xl bg-saffron/25 border border-saffron/50 flex items-center justify-center text-saffron-light shrink-0">
                  <Bot className="w-5 h-5 animate-pulse" />
                </div>
                <div className="px-4 py-3 rounded-2xl bg-nature-950/80 border border-white/20 flex items-center space-x-2 text-xs font-bold text-saffron shadow-md">
                  <span className="w-2 h-2 rounded-full bg-saffron animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 rounded-full bg-saffron animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 rounded-full bg-saffron animate-bounce" style={{ animationDelay: '300ms' }} />
                  <span className="pl-1">Searching BIS Knowledge Base...</span>
                </div>
              </motion.div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* INPUT FORM FOOTER */}
          <div className="p-4 sm:p-5 border-t border-white/15 bg-nature-950/90 backdrop-blur-xl shrink-0">

            {/* ── Voice error banner ── */}
            <AnimatePresence>
              {voiceError && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-3 px-4 py-2.5 rounded-xl bg-red-500/15 border border-red-400/30 text-xs font-semibold text-red-300 flex items-start gap-2"
                >
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
                  <span>{voiceError}</span>
                  <button
                    onClick={() => setVoiceError('')}
                    className="ml-auto text-red-400/70 hover:text-red-300 transition-colors font-bold text-sm leading-none"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Recording indicator ── */}
            <AnimatePresence>
              {isRecording && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-3 px-4 py-2.5 rounded-xl bg-red-500/15 border border-red-400/40 flex items-center gap-2.5"
                >
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                  </span>
                  <span className="text-xs font-bold text-red-300">Recording… Speak your question clearly</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Transcribing indicator ── */}
            <AnimatePresence>
              {isTranscribing && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-3 px-4 py-2.5 rounded-xl bg-saffron/10 border border-saffron/30 flex items-center gap-2.5"
                >
                  <Loader2 className="w-3.5 h-3.5 text-saffron animate-spin shrink-0" />
                  <span className="text-xs font-bold text-saffron">Transcribing your audio…</span>
                </motion.div>
              )}
            </AnimatePresence>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-center space-x-3"
            >
              <input
                type="text"
                value={inputQuery}
                onChange={(e) => setInputQuery(e.target.value)}
                placeholder="Ask about Indian Standards, ISI mark verification, testing rules..."
                className="liquid-input flex-1 text-sm font-semibold placeholder:text-ivory-dim/60"
                disabled={isRecording || isTranscribing}
              />

              {/* ── Microphone button ── */}
              <button
                type="button"
                onClick={isRecording ? stopRecording : startRecording}
                disabled={micDisabled || isTranscribing}
                title={micLabel}
                aria-label={micLabel}
                className={`
                  px-4 py-3 rounded-xl text-sm font-bold flex items-center justify-center shrink-0
                  border transition-all duration-200
                  ${isRecording
                    ? 'bg-red-500/30 border-red-400/60 text-red-300 hover:bg-red-500/40'
                    : isTranscribing
                    ? 'bg-saffron/15 border-saffron/40 text-saffron/70 cursor-not-allowed'
                    : micDisabled
                    ? 'bg-white/5 border-white/10 text-white/30 cursor-not-allowed'
                    : 'bg-white/10 border-white/20 text-ivory hover:bg-white/20 hover:text-white hover:border-white/30'
                  }
                `}
              >
                {isTranscribing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isRecording ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </button>

              {/* ── Send button ── */}
              <button
                type="submit"
                disabled={!inputQuery.trim() || isLoading || micBusy}
                className={`btn-saffron-liquid px-6 py-3 text-sm flex items-center space-x-2 shrink-0 ${
                  !inputQuery.trim() || isLoading || micBusy ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <span>Send</span>
                <Send className="w-4 h-4" />
              </button>
            </form>
            
            <div className="flex flex-col sm:flex-row items-center justify-between px-1 pt-2.5 text-[10px] text-ivory-dim font-semibold gap-1">
              <span className="flex items-center space-x-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-saffron" />
                <span>Verified Bureau of Indian Standards Context • Source-BIS WEBSITE</span>
              </span>
              {/* <span>Jagruk Swadesh Demo Engine</span> */}
            </div>
          </div>

        </div>

      </div>
    </PageTransition>
  );
}
