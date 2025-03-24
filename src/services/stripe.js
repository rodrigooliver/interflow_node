import { supabase } from '../lib/supabase.js';
import { stripe } from '../lib/stripe.js';
import Sentry from '../lib/sentry.js';

// Handle checkout completed
export async function handleCheckoutCompleted(session) {
  const organizationId = session.metadata.organization_id;
  const subscriptionId = session.subscription;

  try {
    // Get subscription details
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = subscription.items.data[0].price.id;

    // Create subscription record
    const { data: sub } = await supabase
      .from('subscriptions')
      .insert({
        organization_id: organizationId,
        plan_id: (await getPlanIdFromPriceId(priceId)),
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_end: new Date(subscription.current_period_end * 1000)
      })
      .select()
      .single();

    // Link Stripe subscription
    await supabase
      .from('stripe_subscriptions')
      .insert({
        subscription_id: sub.id,
        stripe_subscription_id: subscriptionId,
        stripe_price_id: priceId
      });
  } catch (error) {
    console.error('Error handling checkout completed:', error);
    Sentry.captureException(error, {
      tags: {
        handler: 'handleCheckoutCompleted',
        organizationId,
        subscriptionId
      }
    });
    throw error;
  }
}

// Handle invoice paid
export async function handleInvoicePaid(invoice) {
  try {
    const { data: stripeSubscription } = await supabase
      .from('stripe_subscriptions')
      .select('subscription_id')
      .eq('stripe_subscription_id', invoice.subscription)
      .single();

    if (!stripeSubscription) return;

    await supabase
      .from('invoices')
      .insert({
        organization_id: invoice.metadata.organization_id,
        subscription_id: stripeSubscription.subscription_id,
        stripe_invoice_id: invoice.id,
        amount: invoice.amount_paid / 100,
        currency: invoice.currency,
        status: invoice.status,
        paid_at: new Date(invoice.status_transitions.paid_at * 1000),
        pdf_url: invoice.invoice_pdf,
        hosted_invoice_url: invoice.hosted_invoice_url
      });
  } catch (error) {
    console.error('Error handling invoice paid:', error);
    Sentry.captureException(error, {
      tags: {
        handler: 'handleInvoicePaid',
        invoiceId: invoice.id,
        subscriptionId: invoice.subscription
      }
    });
    throw error;
  }
}

// Handle subscription updated
export async function handleSubscriptionUpdated(subscription) {
  try {
    const { data: stripeSubscription } = await supabase
      .from('stripe_subscriptions')
      .select('subscription_id')
      .eq('stripe_subscription_id', subscription.id)
      .single();

    if (!stripeSubscription) return;

    await supabase
      .from('subscriptions')
      .update({
        status: subscription.status,
        current_period_end: new Date(subscription.current_period_end * 1000),
        cancel_at_period_end: subscription.cancel_at_period_end
      })
      .eq('id', stripeSubscription.subscription_id);
  } catch (error) {
    console.error('Error handling subscription updated:', error);
    Sentry.captureException(error, {
      tags: {
        handler: 'handleSubscriptionUpdated',
        subscriptionId: subscription.id
      }
    });
    throw error;
  }
}

// Get plan ID from price ID
export async function getPlanIdFromPriceId(priceId) {
  const { data: plan } = await supabase
    .from('subscription_plans')
    .select('id')
    .eq('stripe_price_id', priceId)
    .single();

  return plan?.id;
}