import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/supabase.js';

// Create checkout session
export async function createCheckoutSession(req, res) {
  const { priceId, organizationId, successUrl, cancelUrl } = req.body;

  try {
    // Get or create Stripe customer
    const { data: stripeCustomer } = await supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('organization_id', organizationId)
      .single();

    let customerId;
    if (stripeCustomer) {
      customerId = stripeCustomer.stripe_customer_id;
    } else {
      // Get organization details
      const { data: org } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single();

      // Create Stripe customer
      const customer = await stripe.customers.create({
        name: org.name,
        metadata: {
          organization_id: organizationId
        }
      });

      // Save Stripe customer ID
      await supabase
        .from('stripe_customers')
        .insert({
          organization_id: organizationId,
          stripe_customer_id: customer.id
        });

      customerId = customer.id;
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        organization_id: organizationId
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
}

// Create portal session
export async function createPortalSession(req, res) {
  const { organizationId, returnUrl } = req.body;

  try {
    // Get Stripe customer
    const { data: stripeCustomer } = await supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('organization_id', organizationId)
      .single();

    if (!stripeCustomer) {
      return res.status(404).json({ error: 'Stripe customer not found' });
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomer.stripe_customer_id,
      return_url: returnUrl
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating portal session:', error);
    res.status(500).json({ error: error.message });
  }
}

// Handle webhook
export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // Log webhook event
    await supabase
      .from('stripe_webhook_events')
      .insert({
        stripe_event_id: event.id,
        type: event.type,
        data: event.data.object
      });

    // Handle specific events
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
}