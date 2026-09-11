/**
 * Vercel Serverless Function Entrypoint
 * Handles all /api/* routes via universal request dispatcher.
 */

import { createRequestHandler, handleRequest } from '../src/server.js';

export function createHandler(options) {
  return createRequestHandler(options);
}

export default async function handler(req, res) {
  return handleRequest(req, res);
}
