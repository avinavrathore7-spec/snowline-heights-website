module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { check_in, check_out, adults = 2, children = 0, room_type } = req.body || {};
  const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
  if (!validDate(check_in) || !validDate(check_out) || check_out <= check_in) return res.status(400).json({ error: "Please choose valid check-in and check-out dates." });
  if (!Number.isInteger(adults) || adults < 1 || adults > 4 || !Number.isInteger(children) || children < 0 || children > 3) return res.status(400).json({ error: "Please check the guest count." });
  if (typeof room_type !== "string" || !room_type.trim()) return res.status(400).json({ error: "Please select a room category." });
  if (room_type === "honeymoon") return res.status(400).json({ error: "Honeymoon Special requires manual confirmation. Please contact the hotel for availability." });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).json({ error: "Availability service setup is incomplete. Please contact the hotel." });

  const headers = { apikey: key, Authorization: "Bearer " + key };
  const base = url.replace(/\/$/, "");
  const q = new URLSearchParams({ select: "id,name,base_price,max_adults", name: "eq." + room_type, is_active: "eq.true", limit: "1" });
  try {
    const typeResponse = await fetch(base + "/rest/v1/room_types?" + q.toString(), { headers });
    if (!typeResponse.ok) {
      const detail = (await typeResponse.text()).slice(0, 500);
      return res.status(502).json({ error: "Supabase room_types request failed", upstream_status: typeResponse.status, detail });
    }
    const types = await typeResponse.json();
    if (!types.length) return res.status(404).json({ error: "Selected room category was not found.", requested_room_type: room_type });
    const type = types[0];
    if (adults > type.max_adults) return res.status(400).json({ error: "This room category allows up to " + type.max_adults + " adults." });

    const roomQuery = new URLSearchParams({ select: "id,room_number,floor", room_type_id: "eq." + type.id, is_active: "eq.true", order: "room_number.asc" });
    const roomsResponse = await fetch(base + "/rest/v1/rooms?" + roomQuery.toString(), { headers });
    if (!roomsResponse.ok) {
      const detail = (await roomsResponse.text()).slice(0, 500);
      return res.status(502).json({ error: "Supabase rooms request failed", upstream_status: roomsResponse.status, detail });
    }
    const rooms = await roomsResponse.json();

    const occupiedQuery = new URLSearchParams({ select: "room_id", stay_dates: "ov.[" + check_in + "," + check_out + ")" });
    const occupiedResponse = await fetch(base + "/rest/v1/booking_rooms?" + occupiedQuery.toString(), { headers });
    if (!occupiedResponse.ok) {
      const detail = (await occupiedResponse.text()).slice(0, 500);
      return res.status(502).json({ error: "Supabase booking_rooms request failed", upstream_status: occupiedResponse.status, detail });
    }
    const occupiedRows = await occupiedResponse.json();
    const occupied = new Set(occupiedRows.map(row => row.room_id));
    const available = rooms.filter(room => !occupied.has(room.id));
    const nights = Math.round((Date.parse(check_out + "T00:00:00Z") - Date.parse(check_in + "T00:00:00Z")) / 86400000);
    return res.status(200).json({ available: available.length > 0, available_rooms: available.length, room_type: type.name, rate_per_night: Number(type.base_price), nights, estimated_total: Number(type.base_price) * nights, message: available.length ? available.length + " room(s) currently available in this category. Estimated total: ₹" + (Number(type.base_price) * nights).toLocaleString("en-IN") + ". This is not a reservation; rooms are not held until booking is completed." : "Sorry, no rooms are available in this category for these dates." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Availability check failed." });
  }
};