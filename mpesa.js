const express = require('express');
const axios = require('axios');
const router = express.Router();

// 1. This is the endpoint your frontend calls: /api/pay
router.post('/pay', async (req, res) => {
  try {
    const { phone, amount } = req.body;

    // Check if phone and amount were sent
    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone and amount are required' });
    }

    // 2. Get Access Token from Safaricom
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    const token = tokenResponse.data.access_token;

    // 3. Generate Timestamp and Password
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14);

    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    // 4. Send STK Push Request
    const stkResponse = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone, // Customer's phone number (e.g., 254712345678)
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `https://your-railway-url.up.railway.app/api/mpesa/callback`, // <-- REPLACE THIS
        AccountReference: 'CurrencyExchange',
        TransactionDesc: 'Payment for currency exchange'
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    // 5. Send the response back to your frontend
    res.json(stkResponse.data);

  } catch (error) {
    console.error('M-Pesa Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment failed to initiate' });
  }
});

// 6. The Webhook (Doorbell) - Safaricom calls this when payment is done
router.post('/mpesa/callback', (req, res) => {
  console.log('M-Pesa Callback Received:', req.body);

  // Check if payment was successful
  const resultCode = req.body.Body?.stkCallback?.ResultCode;
  
  if (resultCode === 0) {
    console.log('✅ Payment Successful!');
    // TODO: Update your database here (mark order as paid)
  } else {
    console.log('❌ Payment Failed or Cancelled');
  }

  // Always respond to Safaricom with a 200 OK
  res.json({ received: true });
});

module.exports = router;
