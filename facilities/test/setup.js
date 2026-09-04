// Jest test setup file
global.fetch = require('node-fetch');

// Increase timeout for network tests
jest.setTimeout(30000);

// Mock console.error to reduce noise in tests
global.console = {
  ...console,
  error: jest.fn(),
  log: jest.fn()
};