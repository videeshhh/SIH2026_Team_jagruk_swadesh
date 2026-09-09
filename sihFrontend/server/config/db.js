const mongoose = require('mongoose');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('[DB] MONGODB_URI is not set in .env — auth routes will not work.');
    return; // don't crash the process; other routes still work
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri);
      console.log('[DB] MongoDB connected:', mongoose.connection.host);
      return; // success
    } catch (err) {
      console.error(`[DB] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[DB] Retrying in ${RETRY_DELAY_MS / 1000}s…`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error('[DB] Could not connect to MongoDB after all retries. Auth routes will return 503.');
        // Do NOT call process.exit — keep the server running for health checks, etc.
      }
    }
  }
}

module.exports = connectDB;
