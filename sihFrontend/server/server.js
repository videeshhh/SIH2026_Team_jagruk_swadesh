require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');

const app = express();

connectDB();

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);

app.post('/api/query', (req, res) => {
  const FASTAPI_HOST = process.env.FASTAPI_HOST || 'localhost';
  const FASTAPI_PORT = parseInt(process.env.FASTAPI_PORT || '8000', 10);

  const body = JSON.stringify(req.body);

  const options = {
    hostname: FASTAPI_HOST,
    port: FASTAPI_PORT,
    path: '/query',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch {
        res.status(500).json({ error: 'Invalid response from RAG pipeline.' });
      }
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[RAG Proxy] FastAPI unreachable:', err.message);
    res.status(502).json({
      error: 'The AI knowledge engine is currently offline. Please ensure the FastAPI server is running on port ' + FASTAPI_PORT + '.',
    });
  });

  proxyReq.write(body);
  proxyReq.end();
});


app.post('/api/transcribe', (req, res) => {
  const FASTAPI_HOST = process.env.FASTAPI_HOST || 'localhost';
  const FASTAPI_PORT = parseInt(process.env.FASTAPI_PORT || '8000', 10);

  const options = {
    hostname: FASTAPI_HOST,
    port: FASTAPI_PORT,
    path: '/transcribe',
    method: 'POST',
    headers: {
    
      'Content-Type': req.headers['content-type'],
  
      ...(req.headers['content-length'] && {
        'Content-Length': req.headers['content-length'],
      }),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch {
        res.status(500).json({ error: 'Invalid response from transcription service.' });
      }
    });
  });

  proxyReq.on('error', (err) => {
    console.error('[Transcribe Proxy] FastAPI unreachable:', err.message);
    res.status(502).json({
      error: 'The AI transcription engine is currently offline. Please ensure the FastAPI server is running on port ' + FASTAPI_PORT + '.',
    });
  });

  req.pipe(proxyReq);
});

app.all('/api/speak', (req, res) => {
  const FASTAPI_HOST = process.env.FASTAPI_HOST || 'localhost';
  const FASTAPI_PORT = parseInt(process.env.FASTAPI_PORT || '8000', 10);

  let path = '/speak';
  if (req.method === 'GET' && req.url.includes('?')) {
    path += req.url.substring(req.url.indexOf('?'));
  }

  const options = {
    hostname: FASTAPI_HOST,
    port: FASTAPI_PORT,
    path: path,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${FASTAPI_HOST}:${FASTAPI_PORT}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[Speak Proxy] FastAPI unreachable:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'The AI speech engine is currently offline.' });
    }
  });

  if (req.method === 'POST') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Unexpected server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API server  → http://localhost:${PORT}`);
  console.log(`FastAPI RAG → http://localhost:${process.env.FASTAPI_PORT || 8000}`);
});
