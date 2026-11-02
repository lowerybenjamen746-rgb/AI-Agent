#!/usr/bin/env node
// Entry point for the reference adapter: starts the worker with its endpoint,
// authentication, health and readiness contracts wired.
import { createExampleWorker } from './example-adapter.mjs';

createExampleWorker();
