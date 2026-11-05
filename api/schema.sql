-- Bookings for sessions, workshops and single numerology questions.
-- A booking is "held" for a short time while the client pays in Bit, "claimed" once she says she paid,
-- and "paid" once Lital confirms the transfer in the admin page.
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'workshop', 'question')),
  service TEXT NOT NULL,
  product TEXT,
  place TEXT,
  pack_mode TEXT,
  date TEXT,
  hour INTEGER,
  workshop_id INTEGER,
  amount INTEGER NOT NULL,
  name TEXT,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'claimed', 'paid', 'cancelled', 'expired')),
  hold_until INTEGER,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  paid_at INTEGER,
  anonymized INTEGER NOT NULL DEFAULT 0
);

-- Two clients can never hold the same session slot at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_slot
  ON bookings (date, hour)
  WHERE kind = 'session' AND date IS NOT NULL AND hour IS NOT NULL AND status IN ('held', 'claimed', 'paid');
CREATE INDEX IF NOT EXISTS bookings_status ON bookings (status, hold_until);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings (date);

CREATE TABLE IF NOT EXISTS workshops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cohort TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'מפגש פתיחה: טעימה מכל העולמות',
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  place TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 72,
  capacity INTEGER NOT NULL DEFAULT 20,
  wa_link TEXT,
  bit_link TEXT, -- Bit wallet link for this workshop's payments
  active INTEGER NOT NULL DEFAULT 1
);
