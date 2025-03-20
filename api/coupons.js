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

// Timeout settings
const NAVIGATION_TIMEOUT = 8000;
const OVERALL_TIMEOUT = 10000;

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

      // Set up overall timeout for the scraping process
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Scraping timeout")), OVERALL_TIMEOUT)
      );

      // Race against timeout
      const coupons = await Promise.race([
        scrapeCoupons(domain),
        timeoutPromise,
      ]);

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
      // Return empty array instead of error to avoid breaking the client
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

// Optimized scraper with early termination
async function scrapeCoupons(domain) {
  let browser = null;

  try {
    // Launch browser with minimal config
    browser = await puppeteer.launch({
      args: [
        ...chrome.args,
        "--hide-scrollbars",
        "--disable-web-security",
        "--disable-extensions",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--js-flags=--expose-gc",
        "--disable-gpu",
      ],
      defaultViewport: { width: 800, height: 600 },
      executablePath: await chrome.executablePath(),
      headless: true,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Optimize page load
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      // Block images, fonts, stylesheets to speed up load
      const resourceType = req.resourceType();
      if (
        resourceType === "image" ||
        resourceType === "font" ||
        resourceType === "stylesheet"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Navigate to CouponFollow with reduced timeout
    const url = `https://couponfollow.com/site/${domain}`;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    // Wait only for the coupon elements we need
    try {
      await page.waitForSelector(".offer-card.regular-offer", {
        timeout: 5000,
      });
    } catch (err) {
      console.log("Selector timeout, continuing with extraction");
    }

    // Extract coupon data with simplified DOM queries
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

        // Get code directly from the element if possible
        let code = "AUTOMATIC";
        const codeEl = element.querySelector(".coupon-code");
        if (codeEl && codeEl.textContent) {
          code = codeEl.textContent.trim();
        }

        coupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
        });
      });

      return coupons;
    });

    // Skip the individual modal URL processing to save time
    // Most codes are usually visible on the main page

    return basicCoupons;
  } catch (error) {
    console.error("Error in scrapeCoupons:", error);
    return []; // Return empty array instead of throwing to avoid breaking the API
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
