require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-04-30.basil',
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors());

// --- Stripe Webhook Route FIRST, with express.raw ---
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('=== Webhook Request Started ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  const signature = req.headers['stripe-signature'];
  const body = req.body;

  if (!signature) {
    console.error('No signature found in request');
    return res.status(400).json({ error: 'No signature found in request' });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    console.log('Attempting to construct event...');
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('Event constructed successfully:', event.type);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed', details: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    console.log('Processing checkout.session.completed event');
    const session = event.data.object;
    console.log('Session ID:', session.id);
    
    // Get customer email from the session
    const customerEmail = session.customer_email || session.customer_details?.email;
    console.log('Customer email:', customerEmail);
    
    if (!customerEmail) {
      console.error('No customer email found in session:', JSON.stringify(session, null, 2));
      return res.status(400).json({ error: 'No customer email found in session' });
    }

    try {
      console.log('Attempting to send password reset email...');
      // Send password reset email using Supabase
      const { data: resetData, error: resetError } = await supabase.auth.resetPasswordForEmail(customerEmail, {
        redirectTo: 'https://app.nextrend.ai/reset-password'
      });

      if (resetError) {
        console.error('Supabase reset password error:', JSON.stringify(resetError, null, 2));
        return res.status(500).json({ 
          error: 'Error sending reset password email', 
          details: resetError.message,
          fullError: resetError
        });
      }

      console.log('Reset password email sent successfully:', JSON.stringify(resetData, null, 2));

      console.log('Attempting to store subscription info...');
      // Store subscription info in a separate table for later use
      const { data: subData, error: subError } = await supabase
        .from('pending_subscriptions')
        .insert({
          email: customerEmail,
          subscription_id: session.subscription,
          status: 'pending',
          created_at: new Date().toISOString()
        })
        .select();

      if (subError) {
        console.error('Error storing subscription info:', JSON.stringify(subError, null, 2));
        // Don't return error here, as the invite was sent successfully
      } else {
        console.log('Subscription info stored successfully:', JSON.stringify(subData, null, 2));
      }

      console.log('=== Webhook Processing Completed Successfully ===');
      return res.json({ 
        success: true, 
        message: 'Invite sent successfully',
        email: customerEmail,
        subscriptionId: session.subscription
      });

    } catch (err) {
      console.error('Unexpected error in webhook processing:', err);
      console.error('Error stack:', err.stack);
      return res.status(500).json({ 
        error: 'Unexpected error', 
        details: err.message,
        stack: err.stack
      });
    }
  }

  console.log('Event type not handled:', event.type);
  res.json({ received: true });
});

// --- All other routes and middleware after ---
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});