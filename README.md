# Interflow Backend

Backend service for Interflow - A multi-channel customer service and CRM platform.

## Overview

Interflow's backend service handles:
- Multi-channel messaging (WhatsApp, Facebook, Instagram, Email)
- Real-time chat functionality
- File attachments and media handling
- Webhook processing for various messaging platforms
- Payment processing with Stripe
- Email integration with IMAP/SMTP

## Technologies

- Node.js
- Express.js
- Supabase (PostgreSQL + Real-time)
- Stripe for payments
- IMAP/SMTP for email integration
- WebSocket for real-time updates

## Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Supabase project
- Stripe account (for payments)

## Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# Server
FRONTEND_URL=http://localhost:5173
API_URL=http://localhost:3002
PORT=3002
NODE_ENV=development

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key

# Stripe
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

# Sentry
SENTRY_DSN=your_sentry

# WAPI
WAPI_ACCOUNT_ID=your_wapi_account_id

# Instagram
INSTAGRAM_CLIENT_ID=your_instagram_client_id
INSTAGRAM_CLIENT_SECRET=your_instagram_client_secret
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=your_instagram_webhook_verify_token

# Facebook/WhatsApp
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_whatsapp_webhook_verify_token
FACEBOOK_CONFIG_ID=your_facebook_config_id
FACEBOOK_BUSINESS_ID=your_facebook_business_id

# Email Configuration
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587  # Use 587 para TLS ou 465 para SSL (não use 993, que é para IMAP)
EMAIL_USER=your_email_username
EMAIL_PASSWORD=your_email_password
EMAIL_FROM=noreply@example.com

# OneSignal
ONESIGNAL_APP_ID=your_onesignal_app_id
ONESIGNAL_REST_API_KEY=your_onesignal_rest_api_key
```

## Installation

1. Clone the repository:
```bash
git clone https://github.com/rodrigooliver/interflow_node.git
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the development server:
```bash
npm run dev
```

## API Routes

### Messaging Webhooks
- `POST /api/webhook/wapi/:channelId` - WhatsApp WApi webhook
- `POST /api/webhook/whatsapp-official/:channelId` - WhatsApp Business API webhook
- `POST /api/webhook/instagram/:channelId` - Instagram webhook
- `POST /api/webhook/facebook/:channelId` - Facebook webhook

### Email Integration
- `POST /api/test-email-connection` - Test IMAP/SMTP connection

### Custom Email Service
- The application can use either Supabase's email service or a custom SMTP server
- When environment variables for email are configured, the system will use the custom SMTP server
- If email environment variables are missing, it falls back to Supabase's email service

### Payments (Stripe)
- `POST /api/stripe/create-checkout-session` - Create payment checkout session
- `POST /api/stripe/create-portal-session` - Create customer portal session
- `POST /api/stripe/webhook` - Stripe webhook handler

## Features

### Multi-Channel Support
- WhatsApp Business API
- WhatsApp WApi
- WhatsApp ZApi
- WhatsApp Evolution API
- Instagram Direct Messages
- Facebook Messenger
- Email (IMAP/SMTP)

### Real-time Messaging
- Message delivery status
- Read receipts
- Typing indicators
- Online/offline status

### File Handling
- Image uploads
- Document attachments
- Voice messages
- Video messages

### Email Integration
- IMAP polling
- SMTP sending
- Email threading
- Attachment handling

### Custom Email Service
- Support for custom SMTP servers
- Personalized email templates
- HTML email formatting
- Fallback to Supabase email service
- Multi-language email templates

### Payment Processing
- Subscription management
- Usage-based billing
- Payment history
- Invoice generation

## Development

### Running Tests
```bash
npm test
```

### Code Style
The project uses ESLint for code style. Run linting with:
```bash
npm run lint
```

### Database Migrations
Database migrations are managed through Supabase. New migrations should be added to the `supabase/migrations` directory.

## Production Deployment

1. Build the application:
```bash
npm run build
```

2. Start in production mode:
```bash
npm start
```

Or use Docker:
```bash
docker-compose up -d
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.