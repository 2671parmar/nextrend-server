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
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Stripe webhook endpoint
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const body = req.body;

  console.log('Received webhook request');
  console.log('Signature:', signature);

  if (!signature) {
    console.error('No signature found in request');
    return res.status(400).send('No signature');
  }

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log('Webhook event type:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('Checkout session:', session);
      
      // Get customer email from the session
      const customerEmail = session.customer_email || session.customer_details?.email;
      
      if (!customerEmail) {
        console.error('No customer email found in session');
        throw new Error('No customer email found in session');
      }

      console.log('Creating user for email:', customerEmail);

      // Create a new user in Supabase
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: customerEmail,
        email_confirm: true,
      });

      console.log('Supabase createUser response:', { authData, authError });

      if (authError) {
        console.error('Error creating user:', authError);
        throw authError;
      }

      console.log('User created successfully:', authData.user.id);

      // Create a profile for the user
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
        throw profileError;
      }

      console.log('Profile created successfully');

      return res.json({ success: true });
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ 
      error: 'Webhook handler failed', 
      details: err.message 
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});