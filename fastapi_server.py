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

    if not audio or not audio.filename:
        raise HTTPException(status_code=400, detail="No audio file provided.")

    audio_bytes = await audio.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    
    content_type = audio.content_type or "audio/webm"
    filename = audio.filename or "recording.webm"

    try:
        transcription = _groq_client.audio.transcriptions.create(
            model="whisper-large-v3",
            file=(filename, audio_bytes, content_type),
            response_format="text",
            language="en",           
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
import re
import edge_tts

class SpeakRequest(BaseModel):
    text: str


def _detect_indic_voice(text: str) -> str:
    """Pick the best Edge TTS voice based on the script used in `text`."""
    checks = [
        (r'[\u0980-\u09FF]', 'bn-IN-TanishaaNeural'),   # Bengali
        (r'[\u0900-\u097F]', 'hi-IN-SwaraNeural'),       # Hindi / Devanagari
        (r'[\u0A00-\u0A7F]', 'pa-IN-OjasNeural'),        # Punjabi
        (r'[\u0B80-\u0BFF]', 'ta-IN-PallaviNeural'),     # Tamil
        (r'[\u0C00-\u0C7F]', 'te-IN-ShrutiNeural'),      # Telugu
        (r'[\u0A80-\u0AFF]', 'gu-IN-DhwaniNeural'),      # Gujarati
        (r'[\u0D00-\u0D7F]', 'ml-IN-SobhanaNeural'),     # Malayalam
        (r'[\u0C80-\u0CFF]', 'kn-IN-SapnaNeural'),       # Kannada
        (r'[\u0600-\u06FF]', 'ur-IN-GulNeural'),         # Urdu
    ]
    for pattern, voice in checks:
        if re.search(pattern, text):
            return voice
    return 'en-IN-NeerjaNeural'


async def _generate_tts_audio_stream(text: str, voice: str):
    """Use edge_tts to synthesize speech and yield raw MP3 bytes as they are generated."""
    communicate = edge_tts.Communicate(text, voice)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            yield chunk["data"]


@server.get("/speak")
@server.post("/speak")
async def speak_text(text: str = None, request: SpeakRequest = None):
    """
    Accepts text, uses Edge TTS to generate speech, and streams the MP3 audio.
    Supports both GET (with ?text=...) and POST (with JSON body) for flexibility.
    """
    # Extract text from either GET query or POST body
    input_text = text if text is not None else (request.text if request else None)
    
    if not input_text or not input_text.strip():
        raise HTTPException(status_code=400, detail="Text is required.")

    try:
        # Clean the text: strip markdown symbols and normalize punctuation
        clean_text = re.sub(r'[*#_`>-]', '', str(input_text)).strip()
        clean_text = clean_text.replace('।', '.')
        if not clean_text:
            clean_text = 'Yes'

        voice = _detect_indic_voice(clean_text)

        return StreamingResponse(
            _generate_tts_audio_stream(clean_text, voice),
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            }
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Speech synthesis failed: {str(exc)}"
        )

@server.get("/health")
def health():
    return {"status": "ok"}
