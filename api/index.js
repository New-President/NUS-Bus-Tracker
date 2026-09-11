/**
 * Vercel Serverless Function Entrypoint
 * Handles all /api/* routes via universal request dispatcher.
 */

import { handleRequest } from '../src/server.js';

export default async function handler(req, res) {
  return handleRequest(req, res);
}

