// File: api/coupons.js
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chrome from "@sparticuz/chromium";

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

      // Otherwise, scrape fresh coupons
      const coupons = await scrapeCoupons(domain);

      // Store the scraped coupons in Supabase
      const { error: upsertError } = await supabase.from("coupons").upsert(
        {
          domain,
          coupons,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "domain",
        }
      );

      if (upsertError) {
        console.error("Error storing coupons:", upsertError);
      }

      return res.status(200).json({ coupons });
    } catch (error) {
      console.error("Error fetching coupons:", error);
      return res.status(500).json({ error: error.message });
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

// Scrape coupons from CouponFollow
async function scrapeCoupons(domain) {
  let browser = null;

  try {
    // Launch browser with Chromium for Vercel
    browser = await puppeteer.launch({
      args: [...chrome.args, "--hide-scrollbars", "--disable-web-security"],
      defaultViewport: chrome.defaultViewport,
      executablePath: await chrome.executablePath(),
      headless: true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    page.setJavaScriptEnabled(true);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Navigate to CouponFollow
    const url = `https://couponfollow.com/site/${domain}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    // Extract coupon data
    const basicCoupons = await page.evaluate(() => {
      const coupons = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      couponElements.forEach((element) => {
        // Only process elements with data-type === "coupon"
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") return;

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");
        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";
        const modalUrl = element.getAttribute("data-modal");

        coupons.push({
          id: idCounter++,
          code: "AUTOMATIC", // Default code, will try to update with actual code
          discount,
          terms,
          verified,
          source: "CouponFollow",
          modalUrl,
        });
      });

      return coupons;
    });

    // Process each coupon to get its code
    const completeCoupons = [];
    for (const coupon of basicCoupons) {
      const { modalUrl, ...couponData } = coupon;

      if (modalUrl) {
        try {
          page.setJavaScriptEnabled(true);
          // Navigate to the modal URL to extract the code
          await page.goto(modalUrl, {
            waitUntil: "networkidle2",
            timeout: 10000,
          });

          // Try to find the code
          const code = await page.evaluate(() => {
            const codeElement = document.querySelector(
              "input#code.input.code, input.input.code"
            );
            return codeElement ? codeElement.value.trim() : null;
          });

          if (code) {
            couponData.code = code;
          }
        } catch (error) {
          console.error(`Error getting code for coupon ${coupon.id}:`, error);
        }
      }

      completeCoupons.push(couponData);
    }

    return completeCoupons;
  } catch (error) {
    console.error("Error in scrapeCoupons:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
