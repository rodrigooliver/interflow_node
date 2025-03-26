import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// Initialize Sentry only if DSN is configured
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
    ],
    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions in development
    profilesSampleRate: 1.0, // Profile all transactions in development
    // Environment & Release
    environment: process.env.NODE_ENV || 'development',
    release: process.env.npm_package_version,
    // Error Filtering
    ignoreErrors: [
      // Add patterns for errors you want to ignore
      'ResizeObserver loop limit exceeded',
      'Network request failed'
    ],
    beforeSend(event) {
      return event;
    }
  });
}

// Export Sentry instance
export default Sentry;