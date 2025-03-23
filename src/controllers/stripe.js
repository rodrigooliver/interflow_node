import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';

// Create checkout session
export async function createCheckoutSession(req, res) {
  const { organizationId } = req.params;
  const { planId, currency, billingPeriod, email } = req.body;

  try {
    // Se o email foi fornecido, atualizar a organização
    if (email) {
      const { error: updateError } = await supabase
        .from('organizations')
        .update({ email })
        .eq('id', organizationId);

      if (updateError) {
        Sentry.captureException(updateError);
        return res.status(500).json({ error: 'Erro ao atualizar email da organização' });
      }
    }

    // Verificar se já existe uma assinatura ativa
    const { data: activeSubscriptions, error: activeSubscriptionError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    // Pegar a assinatura mais recente
    const activeSubscription = activeSubscriptions?.[0];

    // Se já existe uma assinatura ativa com stripe_subscription_id, redirecionar para o Portal do Stripe
    if (activeSubscription?.stripe_subscription_id) {
      // Get Stripe customer
      const { data: stripeCustomer, error: stripeCustomerError } = await supabase
        .from('stripe_customers')
        .select('stripe_customer_id')
        .eq('organization_id', organizationId)
        .single();

      if (stripeCustomerError) {
        Sentry.captureException(stripeCustomerError);
        return res.status(500).json({ error: 'Erro ao buscar cliente Stripe' });
      }

      if (!stripeCustomer) {
        return res.status(404).json({ error: 'Cliente Stripe não encontrado' });
      }

      // Create portal session
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomer.stripe_customer_id,
        return_url: `${process.env.FRONTEND_URL}/app/settings/billing`,
        flow_data: {
          type: 'subscription_update',
          subscription_update: {
            subscription: activeSubscription.stripe_subscription_id
          }
        }
      });

      return res.json({ url: session.url });
    }

    // Buscar o plano de assinatura
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (!plan) {
      return res.status(404).json({ error: 'Plano não encontrado' });
    }

    // Determinar o Stripe price ID baseado na moeda e período
    let stripePriceId;
    if (billingPeriod === 'yearly') {
      stripePriceId = currency === 'BRL' ? plan.stripe_price_id_brl_yearly : plan.stripe_price_id_usd_yearly;
    } else {
      stripePriceId = currency === 'BRL' ? plan.stripe_price_id_brl_monthly : plan.stripe_price_id_usd_monthly;
    }

    if (!stripePriceId) {
      return res.status(400).json({ error: 'Preço não configurado para esta combinação de moeda e período' });
    }

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
        .select('name, email')
        .eq('id', organizationId)
        .single();

      // Create Stripe customer
      const customer = await stripe.customers.create({
        name: org.name,
        email: org.email,
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

    // Se não existe assinatura, criar uma nova sessão de checkout
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      currency: (currency === 'BRL' ? 'brl' : 'usd'),
      line_items: [{
        price: stripePriceId,
        quantity: 1
      }],
      mode: 'subscription',
      subscription_data: {
        metadata: {
          organization_id: organizationId,
          plan_id: planId,
          billing_period: billingPeriod
        }
      },
      success_url: `${process.env.FRONTEND_URL}/app/settings/billing?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/app/settings/billing?canceled=true`,
      metadata: {
        organization_id: organizationId,
        plan_id: planId,
        billing_period: billingPeriod
      }
    });

    // Retornar a URL da sessão de checkout
    return res.json({ url: session.url });
  } catch (error) {
    Sentry.captureException(error);
    res.status(500).json({ error: error.message });
  }
}

// Create portal session
export async function createPortalSession(req, res) {
  const { organizationId } = req.params;

  try {
    // Get Stripe customer
    const { data: stripeCustomer, error: stripeCustomerError } = await supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('organization_id', organizationId)
      .single();

    if (stripeCustomerError) {
      Sentry.captureException(stripeCustomerError);
      return res.status(500).json({ error: 'Erro ao buscar cliente Stripe' });
    }

    if (!stripeCustomer) {
      return res.status(404).json({ error: 'Cliente Stripe não encontrado' });
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomer.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/app/settings/billing`
    });

    res.json({ url: session.url });
  } catch (error) {
    Sentry.captureException(error);
    res.status(500).json({ error: error.message });
  }
}

// Handle webhook
export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body, // O corpo já está no formato bruto devido ao middleware
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
      case 'checkout.session.async_payment_failed':
        await handleCheckoutAsyncPaymentFailed(event.data.object);
        break;
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutAsyncPaymentSucceeded(event.data.object);
        break;
      case 'checkout.session.expired':
        await handleCheckoutExpired(event.data.object);
        break;
      case 'customer.created':
        await handleCustomerCreated(event.data.object);
        break;
      case 'customer.deleted':
        await handleCustomerDeleted(event.data.object);
        break;
      case 'customer.updated':
        await handleCustomerUpdated(event.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        // Evento não tratado
        break;
    }

    res.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
}

// Webhook event handlers
async function handleCheckoutCompleted(session) {
  const { organization_id, plan_id, billing_period, is_invoice_payment, invoice_id, subscription_id } = session.metadata;
  
  try {
    // Verificar se é um pagamento de fatura de atualização de plano
    if (is_invoice_payment === 'true' && invoice_id) {
      // Marcar a fatura como paga
      const invoice = await stripe.invoices.pay(invoice_id);
      
      // Não precisamos fazer mais nada, pois a assinatura já foi atualizada
      return;
    }
    
    // Se não for um pagamento de fatura, continuar com o fluxo normal de nova assinatura
    const subscriptionId = session.subscription;
    
    if (!subscriptionId) {
      Sentry.captureMessage('No subscription ID found in session');
      return;
    }

    // Buscar detalhes da assinatura no Stripe
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    // Buscar todas as assinações ativas ou em trial
    const { data: existingSubscriptions } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('organization_id', organization_id)
      .in('status', ['active', 'trialing']);

    // Preparar dados da nova assinatura
    let subscriptionData = {
      organization_id,
      plan_id,
      stripe_subscription_id: subscriptionId,
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_end: new Date(subscription.current_period_end * 1000),
      cancel_at_period_end: subscription.cancel_at_period_end,
      billing_period
    };

    // Cancelar todas as assinações antigas
    if (existingSubscriptions && existingSubscriptions.length > 0) {
      for (const existingSub of existingSubscriptions) {
        // Não cancelar a assinatura que acabamos de criar
        if (existingSub.stripe_subscription_id === subscriptionId) {
          continue;
        }

        // Cancelar no Stripe
        if (existingSub.stripe_subscription_id) {
          try {
            await stripe.subscriptions.cancel(existingSub.stripe_subscription_id);
          } catch (stripeError) {
            Sentry.captureException(stripeError);
          }
        }
        
        // Marcar como cancelada no banco
        await supabase
          .from('subscriptions')
          .update({ 
            status: 'canceled',
            canceled_at: new Date()
          })
          .eq('id', existingSub.id);
      }
    }

    // Criar nova assinatura
    const { error } = await supabase
      .from('subscriptions')
      .insert(subscriptionData);

    if (error) {
      Sentry.captureException(error);
      throw error;
    }
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCheckoutAsyncPaymentFailed(session) {
  try {
    const { organization_id } = session.metadata;
    
    // Atualizar status da assinatura para falha no pagamento
    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'payment_failed',
        updated_at: new Date()
      })
      .eq('organization_id', organization_id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCheckoutAsyncPaymentSucceeded(session) {
  try {
    const { organization_id } = session.metadata;
    
    // Atualizar status da assinatura para ativo
    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        updated_at: new Date()
      })
      .eq('organization_id', organization_id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCheckoutExpired(session) {
  try {
    const { organization_id } = session.metadata;
    
    // Atualizar status da assinatura para expirado
    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'past_due',
        updated_at: new Date()
      })
      .eq('organization_id', organization_id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCustomerCreated(customer) {
  try {
    const { organization_id } = customer.metadata;
    
    // Verificar se o cliente já existe
    const { data: existingCustomer, error: fetchError } = await supabase
      .from('stripe_customers')
      .select('*')
      .eq('stripe_customer_id', customer.id)
      .eq('organization_id', organization_id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 é o código para "nenhum resultado encontrado"
      throw fetchError;
    }

    // Se o cliente já existe, apenas atualizar o updated_at
    if (existingCustomer) {
      const { error: updateError } = await supabase
        .from('stripe_customers')
        .update({
          updated_at: new Date()
        })
        .eq('stripe_customer_id', customer.id);

      if (updateError) throw updateError;
      return;
    }

    // Se o cliente não existe, criar um novo registro
    const { error: insertError } = await supabase
      .from('stripe_customers')
      .insert({
        organization_id,
        stripe_customer_id: customer.id,
        created_at: new Date()
      });

    if (insertError) throw insertError;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCustomerDeleted(customer) {
  try {
    // Remover cliente do banco de dados
    const { error } = await supabase
      .from('stripe_customers')
      .delete()
      .eq('stripe_customer_id', customer.id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleCustomerUpdated(customer) {
  try {
    // Atualizar informações do cliente
    const { error } = await supabase
      .from('stripe_customers')
      .update({
        updated_at: new Date()
      })
      .eq('stripe_customer_id', customer.id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleInvoicePaid(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const organizationId = subscription.metadata.organization_id;

    // Atualizar período da assinatura
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .update({
        current_period_end: new Date(subscription.current_period_end * 1000),
        status: subscription.status
      })
      .eq('organization_id', organizationId);

    if (subscriptionError) throw subscriptionError;

    // Criar ou atualizar invoice
    const invoiceData = {
      organization_id: organizationId,
      subscription_id: subscription.metadata.subscription_id,
      stripe_invoice_id: invoice.id,
      amount: invoice.amount_paid / 100, // Converter de centavos para unidade monetária
      currency: invoice.currency,
      status: invoice.status,
      paid_at: invoice.status === 'paid' ? new Date(invoice.paid_at * 1000) : null,
      due_date: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
      pdf_url: invoice.invoice_pdf,
      hosted_invoice_url: invoice.hosted_invoice_url,
      metadata: {
        stripe_payment_intent: invoice.payment_intent,
        stripe_charge_id: invoice.charge,
        billing_reason: invoice.billing_reason
      }
    };

    const { error: invoiceError } = await supabase
      .from('invoices')
      .upsert(invoiceData, {
        onConflict: 'stripe_invoice_id'
      });

    if (invoiceError) throw invoiceError;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleInvoicePaymentFailed(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const organizationId = subscription.metadata.organization_id;

    // Atualizar status da assinatura
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .update({
        status: 'past_due'
      })
      .eq('organization_id', organizationId);

    if (subscriptionError) throw subscriptionError;

    // Atualizar ou criar invoice
    const invoiceData = {
      organization_id: organizationId,
      subscription_id: subscription.metadata.subscription_id,
      stripe_invoice_id: invoice.id,
      amount: invoice.amount_due / 100,
      currency: invoice.currency,
      status: invoice.status,
      due_date: new Date(invoice.due_date * 1000),
      pdf_url: invoice.invoice_pdf,
      hosted_invoice_url: invoice.hosted_invoice_url,
      metadata: {
        stripe_payment_intent: invoice.payment_intent,
        last_payment_error: invoice.last_payment_error,
        attempt_count: invoice.attempt_count,
        next_payment_attempt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null
      }
    };

    const { error: invoiceError } = await supabase
      .from('invoices')
      .upsert(invoiceData, {
        onConflict: 'stripe_invoice_id'
      });

    if (invoiceError) throw invoiceError;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleSubscriptionUpdated(subscription) {
  try {
    // Verificar se há atributos anteriores no evento
    const previousAttributes = subscription.previous_attributes;
    
    // Preparar dados para atualização
    const updateData = {
      status: subscription.status,
      current_period_end: new Date(subscription.current_period_end * 1000),
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date()
    };
    
    // Se a assinatura foi reativada (cancel_at_period_end mudou de true para false)
    if (previousAttributes && 
        previousAttributes.cancel_at_period_end === true && 
        subscription.cancel_at_period_end === false) {
      updateData.canceled_at = null;
      updateData.cancel_at = null;
    }
    
    // Se a assinatura foi marcada para cancelamento no final do período
    if (subscription.cancel_at_period_end === true && subscription.canceled_at) {
      updateData.canceled_at = new Date(subscription.canceled_at * 1000);
      
      if (subscription.cancel_at) {
        updateData.cancel_at = new Date(subscription.cancel_at * 1000);
      }
    }
    
    // Se o plano foi alterado
    if (subscription.plan && subscription.plan.id) {
      // Buscar o plano correspondente no banco de dados
      const { data: planData } = await supabase
        .from('subscription_plans')
        .select('id')
        .or(`stripe_price_id_brl_monthly.eq.${subscription.plan.id},stripe_price_id_brl_yearly.eq.${subscription.plan.id},stripe_price_id_usd_monthly.eq.${subscription.plan.id},stripe_price_id_usd_yearly.eq.${subscription.plan.id}`)
        .single();
      
      if (planData) {
        updateData.plan_id = planData.id;
        
        // Determinar o período de cobrança
        if (subscription.plan.interval === 'year') {
          updateData.billing_period = 'yearly';
        } else if (subscription.plan.interval === 'month') {
          updateData.billing_period = 'monthly';
        }
      }
    }
    
    // Atualizar a assinatura no banco de dados
    const { error } = await supabase
      .from('subscriptions')
      .update(updateData)
      .eq('stripe_subscription_id', subscription.id);

    if (error) {
      Sentry.captureException(error);
      throw error;
    }
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}

async function handleSubscriptionDeleted(subscription) {
  try {
    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date()
      })
      .eq('stripe_subscription_id', subscription.id);

    if (error) throw error;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
}