// Vercel serverless function. vercel.json rewrites every /api/* request here;
// the adapter restores the original path and runs the app handler.
import { createVercelHandler } from '../src/vercel.js';

export default createVercelHandler();
