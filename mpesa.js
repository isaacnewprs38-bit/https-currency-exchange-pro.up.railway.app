const express = require('express');
const axios = require('axios');
const router = express.Router();

router.post('/pay', async (req, res) => {
  try {
    const { phone, amount } = req.body;

    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const tokenResponse = await axios.get(
      'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );

    const token = tokenResponse.data.access_token;
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const stkResponse = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: 'https://https-currency-exchange.onrender.com/api/mpesa/callback',
        AccountReference: 'CurrencyExchange',
        TransactionDesc: 'Payment'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json(stkResponse.data);
  } catch (error) {
    console.error('M-Pesa Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment failed' });
  }
});

router.post('/mpesa/callback', (req, res) => {
  console.log('M-Pesa Callback Received:', req.body);
  res.json({ received: true });
});

module.exports = router;
