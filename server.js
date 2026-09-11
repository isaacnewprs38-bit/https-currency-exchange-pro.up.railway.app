require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 5000;

// PostgreSQL connection
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    stripe_customer_id TEXT,
    subscription_id TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

db.query(`
  CREATE TABLE IF NOT EXISTS conversions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    from_currency TEXT,
    to_currency TEXT,
    amount REAL,
    result REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Health check
app.get('/', (req, res) => res.json({ message: 'Currency Exchange API running' }));

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email || null, hashed]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email || '' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.constraint === 'users_username_key' || err.constraint === 'users_email_key')
      return res.status(400).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1 OR email = $1', [identifier]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email || '' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user', authenticate, async (req, res) => {
  try {
    const result = await db.query('SELECT id, username, email, plan FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversions', authenticate, async (req, res) => {
  const { fromCurrency, toCurrency, amount, result } = req.body;
  if (!fromCurrency || !toCurrency || amount == null || result == null)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const userResult = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (user.plan === 'free') {
      const countResult = await db.query(
        'SELECT COUNT(*) as count FROM conversions WHERE user_id = $1 AND date(created_at) = CURRENT_DATE',
        [req.user.id]
      );
      if (parseInt(countResult.rows[0].count) >= 50)
        return res.status(403).json({ error: 'Free limit reached (50/day). Upgrade to premium.' });
    }
    await db.query(
      'INSERT INTO conversions (user_id, from_currency, to_currency, amount, result) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, fromCurrency, toCurrency, amount, result]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversions', authenticate, async (req, res) => {
  try {
    const userResult = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    let query = 'SELECT * FROM conversions WHERE user_id = $1 ORDER BY created_at DESC';
    if (user.plan === 'free') query += ' LIMIT 7';
    const result = await db.query(query, [req.user.id]);
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export-csv', authenticate, async (req, res) => {
  try {
    const userResult = await db.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (user.plan !== 'premium') return res.status(403).json({ error: 'Premium feature' });
    const result = await db.query('SELECT * FROM conversions WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    let csv = 'Date,From,To,Amount,Result\n';
    result.rows.forEach(r => csv += `${r.created_at},${r.from_currency},${r.to_currency},${r.amount},${r.result}\n`);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=history.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-checkout-session', authenticate, async (req, res) => {
  try {
    const userResult = await db.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || `${req.user.username}@example.com`,
        metadata: { username: req.user.username }
      });
      customerId = customer.id;
      await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: process.env.CLIENT_URL + '/app-with-auth.html?success=true',
      cancel_url: process.env.CLIENT_URL + '/app-with-auth.html?canceled=true',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const plan = (subscription.status === 'active' || subscription.status === 'trialing') ? 'premium' : 'free';
    await db.query(
      'UPDATE users SET plan = $1, subscription_id = $2 WHERE stripe_customer_id = $3',
      [plan, subscription.id, customerId]
    );
  } else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    await db.query('UPDATE users SET plan = $1, subscription_id = NULL WHERE stripe_customer_id = $2', ['free', customerId]);
  }
  res.json({ received: true });
});

app.get('/api/convert', (req, res) => {
  const { from, to, amount } = req.query;
  const rates = { USD: 1, EUR: 0.85, GBP: 0.73, JPY: 110, CAD: 1.25, AUD: 1.35, CHF: 0.92, CNY: 6.45 };
  const fromRate = rates[from] || 1;
  const toRate = rates[to] || 1;
  const result = (parseFloat(amount) / fromRate) * toRate;
  res.json({ result: parseFloat(result.toFixed(4)) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
