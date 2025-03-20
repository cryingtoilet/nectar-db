// File: api/coupons/index.js
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Cache TTL (24 hours in seconds)
const CACHE_TTL = 86400;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // Handle preflight request
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // GET request to fetch coupons for a domain
  if (req.method === "GET") {
    const { domain } = req.query;

    if (!domain) {
      return res.status(400).json({ error: "Domain parameter is required" });
    }

    try {
      // Check if we have cached coupons in Supabase
      const { data: cachedCoupons, error } = await supabase
        .from("coupons")
        .select("*")
        .eq("domain", domain)
        .gt(
          "updated_at",
          new Date(Date.now() - CACHE_TTL * 1000).toISOString()
        );

      // If we have fresh cached coupons, return them
      if (!error && cachedCoupons && cachedCoupons.length > 0) {
        return res.status(200).json({ coupons: cachedCoupons[0].coupons });
      }

      // If no cached data, initiate a scrape job
      const response = await fetch(
        `${
          process.env.VERCEL_URL || "http://localhost:3000"
        }/api/coupons/scrape`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ domain }),
        }
      );

      // Return empty array for now, the client will retry later
      return res.status(200).json({
        coupons: [],
        message: "Coupons are being scraped, please try again in a few seconds",
      });
    } catch (error) {
      console.error("Error fetching coupons:", error);
      return res.status(200).json({ coupons: [] });
    }
  }

  // POST request to store coupons
  if (req.method === "POST") {
    const { domain, coupons } = req.body;

    if (!domain || !coupons) {
      return res.status(400).json({ error: "Domain and coupons are required" });
    }

    try {
      const { error } = await supabase.from("coupons").upsert(
        {
          domain,
          coupons,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "domain",
        }
      );

      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error storing coupons:", error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
