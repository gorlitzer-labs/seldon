// Mirrors demerzel/protocol.py. Kept tiny and separate so the avatar can import the
// same constants instead of hardcoding ports and rates a second time.
export const WS_PORT = 8765;
export const MIC_SR = 16000;
export const TTS_SR = 24000;
export const STATES = ['idle', 'listening', 'thinking', 'speaking'];
