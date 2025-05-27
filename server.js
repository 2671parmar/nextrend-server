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
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed', details: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Try to get email robustly
    const customerEmail = session.customer_email || session.customer_details?.email;
    if (!customerEmail) {
      console.error('No customer email found in session:', session);
      return res.status(400).json({ error: 'No customer email found in session' });
    }

    // Create user in Supabase
    try {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: customerEmail,
        email_confirm: true,
      });
      if (authError) {
        console.error('Error creating user:', authError);
        return res.status(500).json({ error: 'Error creating user', details: authError.message });
      }

      // Create profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email: customerEmail,
          subscription_status: 'active',
          subscription_id: session.subscription,
          created_at: new Date().toISOString(),
        });

      if (profileError) {
        console.error('Error creating profile:', profileError);
        return res.status(500).json({ error: 'Error creating profile', details: profileError.message });
      }

      return res.json({ success: true, userId: authData.user.id });
    } catch (err) {
      console.error('Unexpected error:', err);
      return res.status(500).json({ error: 'Unexpected error', details: err.message });
    }
  }

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