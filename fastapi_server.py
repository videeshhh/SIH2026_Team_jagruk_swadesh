from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from jagruk_brain_pipeline.main import app as pipeline_app
from openai import OpenAI
import os
from dotenv import load_dotenv

load_dotenv()

server = FastAPI()

server.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

# Groq client for Whisper transcription
_groq_client = OpenAI(
    api_key=os.getenv("API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)

class QueryRequest(BaseModel):
    query: str

@server.post("/query")
def run_query(request: QueryRequest):
    initial_state = {
        "medium": "1",
        "raw_query": request.query
    }
    final_state = pipeline_app.invoke(initial_state)
    answer = final_state.get("final_answer", "No answer returned.")
    return {"answer": answer}

@server.post("/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """
    Accept an audio file (WebM / WAV / MP3 / OGG) from the browser,
    send it to Groq Whisper for speech-to-text, and return the transcript.
    """
    # Validate that a file was actually sent
    if not audio or not audio.filename:
        raise HTTPException(status_code=400, detail="No audio file provided.")

    # Read the raw bytes
    audio_bytes = await audio.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Audio file is empty.")

    # Groq Whisper expects a file-like tuple: (filename, bytes, content_type)
    # The browser's MediaRecorder typically produces audio/webm
    content_type = audio.content_type or "audio/webm"
    filename = audio.filename or "recording.webm"

    try:
        transcription = _groq_client.audio.transcriptions.create(
            model="whisper-large-v3",
            file=(filename, audio_bytes, content_type),
            response_format="text",
            language="en",           # Accepts Hindi/English mixed — Whisper handles it
        )
        # Groq returns a plain string when response_format="text"
        transcript_text = transcription if isinstance(transcription, str) else transcription.text
        return {"transcript": transcript_text.strip()}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Transcription failed: {str(exc)}"
        )

from fastapi.responses import StreamingResponse
import io

from jagruk_brain_pipeline.voice_agent import client as voice_client

class SpeakRequest(BaseModel):
    text: str

@server.post("/speak")
def speak_text(request: SpeakRequest):
    """
    Accepts text, uses the patched local TTS to generate speech, and streams the WAV audio back.
    """
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text is required.")
        
    try:
        # We use the patched client from voice_agent which intercepts this 
        # and runs the edge-tts offline engine instead of making an API call.
        tts_response = voice_client.audio.speech.create(
            model="canopylabs/orpheus-v1-english",
            voice="troy",
            input=request.text.strip(),
            response_format="wav"
        )
        
        # Depending on how the client patches TTS, we extract the bytes
        # Standard OpenAI client returns an HttpxBinaryResponseContent with .content
        # Patched TTS Response has .read()
        audio_data = None
        if hasattr(tts_response, "read"):
            audio_data = tts_response.read()
        elif hasattr(tts_response, "content"):
            audio_data = tts_response.content
        else:
            raise ValueError("Unrecognized TTS response format")

        return StreamingResponse(
            io.BytesIO(audio_data),
            media_type="audio/wav"
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Speech synthesis failed: {str(exc)}"
        )

@server.get("/health")
def health():
    return {"status": "ok"}
