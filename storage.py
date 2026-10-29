"""SQLite storage layer (stdlib only): schema + migrations, upserts, snapshots, queries.

Everything the API needs from the database lives here so it can be unit-tested without
FastAPI. Connections are short-lived and always closed (sqlite3's own `with` only commits).
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

SCHEMA_VERSION = 3

SORTS = {
    "price": "price IS NULL ASC, price ASC, lot_id ASC",
    "price_desc": "price IS NULL ASC, price DESC, lot_id ASC",
    "title": "title COLLATE NOCASE ASC, lot_id ASC",
    "recent": "last_seen DESC, lot_id ASC",
    "new": "first_seen DESC, CAST(lot_id AS INTEGER) DESC",
}


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def like_escape(text):
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class Store:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=20)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=20000")
        try:
            yield con
            con.commit()
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    # ---- schema / migrations (PRAGMA user_version)
    def migrate(self):
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            version = c.execute("PRAGMA user_version").fetchone()[0]
            if version < 1:
                c.executescript("""
                CREATE TABLE IF NOT EXISTS lots(
                    lot_id TEXT PRIMARY KEY, title TEXT, serial TEXT, rarity TEXT,
                    price INTEGER, status TEXT, image_url TEXT, lot_url TEXT,
                    first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
                CREATE TABLE IF NOT EXISTS price_history(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, lot_id TEXT, price INTEGER,
                    status TEXT, observed_at TEXT);
                CREATE TABLE IF NOT EXISTS market_snapshots(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at TEXT NOT NULL, source TEXT,
                    active_lots INTEGER, priced INTEGER, min_price REAL, max_price REAL,
                    avg_price REAL, median_price REAL);
                CREATE TABLE IF NOT EXISTS support_payments(
                    intent_id TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, test INTEGER,
                    status TEXT, error TEXT, created_at TEXT, updated_at TEXT);
                CREATE INDEX IF NOT EXISTS idx_history_lot_date ON price_history(lot_id, observed_at);
                CREATE INDEX IF NOT EXISTS idx_lots_active_price ON lots(active, price);
                CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots(observed_at);
                """)
            if version < 2:
                c.executescript("""
                CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
                CREATE INDEX IF NOT EXISTS idx_lots_first_seen ON lots(active, first_seen);
                CREATE INDEX IF NOT EXISTS idx_lots_title ON lots(title COLLATE NOCASE);
                CREATE INDEX IF NOT EXISTS idx_history_date ON price_history(observed_at);
                """)
            if version < 3:
                # Confirmed sales from /market/history. No seller/buyer names are stored.
                c.executescript("""
                CREATE TABLE IF NOT EXISTS sales(
                    sale_key TEXT PRIMARY KEY, lot_id TEXT NOT NULL, title TEXT, price INTEGER,
                    time_raw TEXT, sold_at TEXT, first_observed TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_sales_lot ON sales(lot_id);
                CREATE INDEX IF NOT EXISTS idx_sales_observed ON sales(first_observed);
                """)
            c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    # ---- small key/value state that must survive restarts
    def kv_get(self, key, default=None):
        with self.connect() as c:
            row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def kv_set(self, key, value):
        with self.connect() as c:
            if value is None:
                c.execute("DELETE FROM kv WHERE key=?", (key,))
            else:
                c.execute("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                          (key, str(value), utcnow()))

    # ---- writes
    @staticmethod
    def upsert_lot(c, row, now):
        """Insert/update one lot; append history only when price or status changed.

        Returns (is_new, changed).
        """
        old = c.execute("SELECT price,status,first_seen FROM lots WHERE lot_id=?", (row["lot_id"],)).fetchone()
        price, status = row.get("price"), row.get("status") or "Неизвестно"
        c.execute("""INSERT INTO lots(lot_id,title,serial,rarity,price,status,image_url,lot_url,first_seen,last_seen,active)
            VALUES(?,?,?,?,?,?,?,?,?,?,1)
            ON CONFLICT(lot_id) DO UPDATE SET title=excluded.title, serial=excluded.serial, rarity=excluded.rarity,
              price=excluded.price, status=excluded.status, image_url=excluded.image_url, lot_url=excluded.lot_url,
              last_seen=excluded.last_seen, active=1""",
                  (row["lot_id"], row.get("title", ""), row.get("serial", ""), row.get("rarity", ""), price, status,
                   row.get("image_url", ""), row.get("lot_url", ""), old["first_seen"] if old else now, now))
        changed = (not old) or old["price"] != price or old["status"] != status
        if changed:
            c.execute("INSERT INTO price_history(lot_id,price,status,observed_at) VALUES(?,?,?,?)",
                      (row["lot_id"], price, status, now))
        return (not old), changed

    def upsert_many(self, rows, now=None):
        now = now or utcnow()
        new = changed = 0
        with self.connect() as c:
            for row in rows:
                is_new, ch = self.upsert_lot(c, row, now)
                new += is_new
                changed += ch
        return {"new": new, "changed": changed, "saved": len(rows), "observed_at": now}

    def deactivate_unseen(self, since_iso):
        """Only call after a COMPLETE pass: lots not seen since `since_iso` are no longer listed."""
        with self.connect() as c:
            return c.execute("UPDATE lots SET active=0 WHERE active=1 AND last_seen < ?", (since_iso,)).rowcount

    def record_snapshot(self, source, summarize):
        now = utcnow()
        with self.connect() as c:
            total = c.execute("SELECT COUNT(*) FROM lots WHERE active=1").fetchone()[0]
            prices = [r[0] for r in c.execute("SELECT price FROM lots WHERE active=1 AND price IS NOT NULL")]
            s = summarize(prices)
            c.execute("""INSERT INTO market_snapshots(observed_at,source,active_lots,priced,min_price,max_price,avg_price,median_price)
                         VALUES(?,?,?,?,?,?,?,?)""", (now, source, total, s["priced"], s["min"], s["max"], s["avg"], s["median"]))
        return now

    # ---- reads
    def catalog(self, q="", sort="price", status="", rarity="", min_price=None, max_price=None, limit=50, offset=0):
        where, args = ["active=1"], []
        if q:
            like = "%" + like_escape(q.strip()) + "%"
            where.append("(title LIKE ? ESCAPE '\\' OR lot_id LIKE ? ESCAPE '\\' OR serial LIKE ? ESCAPE '\\')")
            args += [like, like, like]
        if status:
            where.append("status=?"); args.append(status)
        if rarity:
            where.append("rarity=?"); args.append(rarity)
        if min_price is not None:
            where.append("price>=?"); args.append(min_price)
        if max_price is not None:
            where.append("price<=?"); args.append(max_price)
        order = SORTS.get(sort, SORTS["price"])
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        clause = " AND ".join(where)
        with self.connect() as c:
            total = c.execute(f"SELECT COUNT(*) FROM lots WHERE {clause}", args).fetchone()[0]
            rows = c.execute(f"SELECT * FROM lots WHERE {clause} ORDER BY {order} LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        return [dict(r) for r in rows], total

    def lots_by_ids(self, ids):
        """Rows (active or not) for up to 100 ids; used by favorites."""
        ids = [str(i) for i in ids][:100]
        if not ids:
            return []
        with self.connect() as c:
            marks = ",".join("?" * len(ids))
            return [dict(r) for r in c.execute(f"SELECT * FROM lots WHERE lot_id IN ({marks})", ids)]

    # ---- confirmed sales (history page)
    def upsert_sales(self, rows, now=None):
        """Idempotent: a sale_key already stored is left untouched. Returns number of NEW rows."""
        now = now or utcnow()
        with self.connect() as c:
            before = c.total_changes
            for r in rows:
                c.execute("INSERT OR IGNORE INTO sales(sale_key,lot_id,title,price,time_raw,sold_at,first_observed) VALUES(?,?,?,?,?,?,?)",
                          (r["sale_key"], r["lot_id"], r.get("title", ""), r.get("price"), r.get("time_raw", ""), r.get("sold_at"), now))
            return c.total_changes - before

    def sales(self, limit=5000):
        with self.connect() as c:
            return [dict(r) for r in c.execute(
                "SELECT lot_id,title,price,time_raw,sold_at,first_observed FROM sales ORDER BY first_observed DESC, rowid DESC LIMIT ?",
                (max(1, min(int(limit), 50000)),))]

    def facets(self):
        with self.connect() as c:
            statuses = [r[0] for r in c.execute("SELECT DISTINCT status FROM lots WHERE active=1 AND status!='' ORDER BY status")]
            rarities = [r[0] for r in c.execute("SELECT DISTINCT rarity FROM lots WHERE active=1 AND rarity!='' ORDER BY rarity")]
        return {"statuses": statuses, "rarities": rarities}

    def active_prices(self):
        with self.connect() as c:
            return [r[0] for r in c.execute("SELECT price FROM lots WHERE active=1 AND price IS NOT NULL")]

    def active_lots(self, priced_only=True):
        with self.connect() as c:
            sql = ("SELECT * FROM lots WHERE active=1" + (" AND price IS NOT NULL" if priced_only else "")
                   + " ORDER BY first_seen ASC, rowid ASC")
            # The crawler inserts page 1 first, preserving the market's displayed order.
            # This lets the snapshot's first lot reliably mean the first gift on page 1.
            return [dict(r) for r in c.execute(sql)]

    def gone_lots(self):
        with self.connect() as c:
            return [dict(r) for r in c.execute("SELECT title,rarity,price FROM lots WHERE active=0 AND price IS NOT NULL")]

    def counts(self):
        with self.connect() as c:
            r = c.execute("""SELECT (SELECT COUNT(*) FROM lots WHERE active=1) active_total,
                                    (SELECT COUNT(*) FROM lots WHERE active=1 AND price IS NOT NULL) active_priced,
                                    (SELECT COUNT(*) FROM lots WHERE active=0) inactive,
                                    (SELECT COUNT(*) FROM price_history) history_rows,
                                    (SELECT COUNT(*) FROM market_snapshots) snapshots,
                                    (SELECT MAX(last_seen) FROM lots) last_seen""").fetchone()
        return dict(r)

    def rarity_counts(self, limit=8):
        with self.connect() as c:
            return [(r[0], r[1]) for r in c.execute(
                "SELECT COALESCE(NULLIF(rarity,''),'Не указана') r, COUNT(*) n FROM lots WHERE active=1 GROUP BY r ORDER BY n DESC LIMIT ?", (limit,))]

    def latest_lot(self):
        with self.connect() as c:
            r = c.execute("SELECT * FROM lots WHERE active=1 ORDER BY first_seen DESC, CAST(lot_id AS INTEGER) DESC LIMIT 1").fetchone()
        return dict(r) if r else None

    def drops(self, limit=12, days=None):
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat() if days else ""
        with self.connect() as c:
            rows = c.execute("""
                WITH ranked AS (
                  SELECT lot_id, price, observed_at,
                         ROW_NUMBER() OVER (PARTITION BY lot_id ORDER BY observed_at DESC, id DESC) rn
                  FROM price_history WHERE price IS NOT NULL)
                SELECT l.lot_id, l.title, l.price, l.lot_url, l.image_url, p.price AS previous_price, r.observed_at AS changed_at
                FROM ranked r JOIN ranked p ON p.lot_id=r.lot_id AND p.rn=2
                JOIN lots l ON l.lot_id=r.lot_id
                WHERE r.rn=1 AND l.active=1 AND r.price < p.price AND r.observed_at >= ?
                ORDER BY (p.price - r.price) * 1.0 / p.price DESC LIMIT ?""", (cutoff, limit)).fetchall()
        return [{**dict(r), "drop_pct": round((1 - r["price"] / r["previous_price"]) * 100, 1)} for r in rows]

    def period_change(self, days):
        """Change of the market median between the first and last snapshot in the period."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self.connect() as c:
            rows = c.execute("SELECT observed_at, median_price FROM market_snapshots "
                             "WHERE observed_at>=? AND median_price IS NOT NULL ORDER BY observed_at", (cutoff,)).fetchall()
        if len(rows) < 2 or not rows[0]["median_price"]:
            return {"days": days, "snapshots": len(rows), "change_pct": None}
        first, last = rows[0]["median_price"], rows[-1]["median_price"]
        return {"days": days, "snapshots": len(rows), "from": first, "to": last,
                "change_pct": round((last / first - 1) * 100, 1)}

    def backup(self, dest_path):
        """Consistent copy of the live database (sqlite online backup API)."""
        src = sqlite3.connect(self.path, timeout=20)
        try:
            dst = sqlite3.connect(dest_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
