module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Booking service is not configured." });
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const rest = async (path, options = {}) => fetch(base + "/rest/v1/" + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = req.body || {};
  const { check_in, check_out, adults, children = 0, room_type, guest_name, guest_email = null, guest_phone } = body;
  const validDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
  if (!validDate(check_in) || !validDate(check_out) || check_out <= check_in) return res.status(400).json({ error: "Choose valid check-in and check-out dates." });
  if (!Number.isInteger(adults) || adults < 1 || adults > 4 || !Number.isInteger(children) || children < 0 || children > 3) return res.status(400).json({ error: "Invalid guest count." });
  if (typeof guest_name !== "string" || guest_name.trim().length < 2 || typeof guest_phone !== "string" || !/^[+0-9 ()-]{8,18}$/.test(guest_phone.trim())) return res.status(400).json({ error: "Enter guest name and a valid phone number." });
  if (guest_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest_email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof room_type !== "string" || !room_type.trim() || room_type === "honeymoon") return res.status(400).json({ error: "This room category needs manual confirmation. Please contact the hotel." });

  try {
    // Release expired 10-minute pending holds before checking inventory.
    const expiry = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleResp = await rest("bookings?select=id&booking_status=eq.pending&payment_status=eq.pending&created_at=lt." + encodeURIComponent(expiry));
    if (!staleResp.ok) throw new Error("Could not verify expired holds.");
    const stale = await staleResp.json();
    if (stale.length) {
      const ids = stale.map(x => x.id);
      const inList = "(" + ids.join(",") + ")";
      const del = await rest("booking_rooms?booking_id=in." + encodeURIComponent(inList), { method: "DELETE" });
      if (!del.ok) throw new Error("Could not release expired room holds.");
      const cancel = await rest("bookings?id=in." + encodeURIComponent(inList), { method: "PATCH", body: JSON.stringify({ booking_status: "cancelled", payment_status: "failed" }) });
      if (!cancel.ok) throw new Error("Could not expire old pending bookings.");
    }

    const typeResp = await rest("room_types?select=id,name,base_price,max_adults&is_active=eq.true");
    if (!typeResp.ok) throw new Error("Could not load room categories.");
    const types = await typeResp.json();
    const norm = s => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
    const type = types.find(t => norm(t.name) === norm(room_type));
    if (!type) return res.status(404).json({ error: "Selected room category was not found.", available_categories: types.map(t => t.name) });
    if (adults > type.max_adults) return res.status(400).json({ error: "This category allows up to " + type.max_adults + " adults." });

    const roomResp = await rest("rooms?select=id,room_number&room_type_id=eq." + type.id + "&is_active=eq.true&order=room_number.asc");
    if (!roomResp.ok) throw new Error("Could not load room inventory.");
    const rooms = await roomResp.json();
    const occupiedResp = await rest("booking_rooms?select=room_id&stay_dates=ov.[" + check_in + "," + check_out + ")");
    if (!occupiedResp.ok) throw new Error("Could not check room inventory.");
    const occupied = new Set((await occupiedResp.json()).map(x => x.room_id));
    const room = rooms.find(r => !occupied.has(r.id));
    if (!room) return res.status(409).json({ error: "Sorry, this category is no longer available for those dates. Please check again." });

    const nights = Math.round((Date.parse(check_out + "T00:00:00Z") - Date.parse(check_in + "T00:00:00Z")) / 86400000);
    const amount = Number(type.base_price) * nights;
    const code = "SH" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
    const bookingResp = await rest("bookings", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({
      booking_code: code, guest_name: guest_name.trim(), guest_email: guest_email || null, guest_phone: guest_phone.trim(),
      adults, children, check_in, check_out, total_amount: amount, booking_status: "pending", payment_status: "pending"
    }) });
    if (!bookingResp.ok) throw new Error("Could not create booking hold.");
    const booking = (await bookingResp.json())[0];
    const linkResp = await rest("booking_rooms", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      booking_id: booking.id, room_id: room.id, stay_dates: "[" + check_in + "," + check_out + ")"
    }) });
    if (!linkResp.ok) {
      await rest("bookings?id=eq." + booking.id, { method: "DELETE" });
      if (linkResp.status === 409 || linkResp.status === 400) return res.status(409).json({ error: "That room was just booked by someone else. Please check availability again." });
      throw new Error("Could not hold the selected room.");
    }

    return res.status(201).json({
      success: true, booking_code: code, hold_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      room_number: room.room_number, room_type: type.name, nights, amount,
      payment_ready: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      message: "Room held for 10 minutes. Payment must be completed before the hold expires."
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Booking could not be created." });
  }
};