module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!base || !serviceKey) return res.status(503).json({ error: "Booking service is not configured." });
  if (!keyId || !keySecret) return res.status(503).json({ error: "Online payment is not configured yet. Please contact the hotel." });

  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  const rest = (path, options = {}) => fetch(base + "/rest/v1/" + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const bookingCode = String((req.body || {}).booking_code || "").trim();
  if (!bookingCode) return res.status(400).json({ error: "Booking code is required." });

  try {
    const bookingResp = await rest("bookings?select=id,booking_code,total_amount,booking_status,payment_status,created_at&booking_code=eq." + encodeURIComponent(bookingCode) + "&limit=1");
    if (!bookingResp.ok) throw new Error("Could not load booking.");
    const rows = await bookingResp.json();
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: "Booking not found." });
    if (booking.booking_status !== "pending" || booking.payment_status !== "pending") return res.status(409).json({ error: "This booking is no longer payable." });
    const createdAt = Date.parse(booking.created_at);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000) return res.status(410).json({ error: "Your 10-minute room hold has expired. Please check availability again." });
    const roomResp = await rest("booking_rooms?select=id&booking_id=eq." + booking.id + "&limit=1");
    if (!roomResp.ok) throw new Error("Could not verify the room hold.");
    if (!(await roomResp.json()).length) return res.status(409).json({ error: "The room hold is no longer active." });

    const totalAmount = Number(booking.total_amount);\n    const advanceAmount = Math.round(totalAmount * 0.25 * 100) / 100;\n    const amount = Math.round(advanceAmount * 100);
    if (!Number.isSafeInteger(amount) || amount < 100) return res.status(400).json({ error: "Invalid booking amount." });
    const auth = Buffer.from(keyId + ":" + keySecret).toString("base64");
    const razorResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, currency: "INR", receipt: booking.booking_code, notes: { booking_code: booking.booking_code } })
    });
    const razorData = await razorResp.json();
    if (!razorResp.ok) return res.status(502).json({ error: razorData.error && razorData.error.description || "Could not create payment order." });

    const paymentResp = await rest("payments", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ booking_id: booking.id, provider: "razorpay", provider_order_id: razorData.id, amount: advanceAmount, payment_status: "created" })
    });
    if (!paymentResp.ok) throw new Error("Payment order was created but could not be recorded. Contact the hotel with booking code " + booking.booking_code + ".");
    return res.status(200).json({ success: true, key_id: keyId, order_id: razorData.id, amount: razorData.amount, currency: razorData.currency, booking_code: booking.booking_code, total_amount: totalAmount, advance_amount: advanceAmount, balance_due: Math.round((totalAmount - advanceAmount) * 100) / 100 });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not start payment." });
  }
};
