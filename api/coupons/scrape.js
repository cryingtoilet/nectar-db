// File: api/coupons/scrape.js
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chrome from "@sparticuz/chromium";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: "Domain parameter is required" });
  }

  // Send an immediate response to prevent timeout
  res.status(202).json({ message: "Scraping started" });

  // Continue processing asynchronously
  try {
    const coupons = await scrapeCoupons(domain);

    // Store the scraped coupons in Supabase
    await supabase.from("coupons").upsert(
      {
        domain,
        coupons,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "domain",
      }
    );

    console.log(
      `Successfully scraped and stored ${coupons.length} coupons for ${domain}`
    );
  } catch (error) {
    console.error(`Error scraping coupons for ${domain}:`, error);
  }
}

// Optimized scraper
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
      // Block unnecessary resources
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
      timeout: 12000,
    });

    // Wait for the coupon elements
    try {
      await page.waitForSelector(".offer-card.regular-offer", {
        timeout: 5000,
      });
    } catch (err) {
      console.log("Selector timeout, continuing with extraction");
    }

    // Extract coupon data
    const basicCoupons = await page.evaluate(() => {
      const coupons = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      couponElements.forEach((element) => {
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") return;

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");
        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";
        const modalUrl = element.getAttribute("data-modal");

        // Get code directly if possible
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
          modalUrl,
        });
      });

      return coupons;
    });

    // Only try to get codes for a few top coupons to save time
    const completeCoupons = [];
    const couponLimit = Math.min(basicCoupons.length, 5); // Only process top 5 coupons

    for (let i = 0; i < couponLimit; i++) {
      const { modalUrl, ...couponData } = basicCoupons[i];

      if (modalUrl && couponData.code === "AUTOMATIC") {
        try {
          // Navigate to the modal URL to extract the code
          await page.goto(modalUrl, {
            waitUntil: "domcontentloaded",
            timeout: 8000,
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
          console.error(
            `Error getting code for coupon ${couponData.id}:`,
            error
          );
        }
      }

      completeCoupons.push(couponData);
    }

    // Add remaining coupons without processing modals
    for (let i = couponLimit; i < basicCoupons.length; i++) {
      const { modalUrl, ...couponData } = basicCoupons[i];
      completeCoupons.push(couponData);
    }

    return completeCoupons;
  } catch (error) {
    console.error("Error in scrapeCoupons:", error);
    return []; // Return empty array instead of throwing
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
