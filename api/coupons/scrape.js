import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer-core";
import chrome from "@sparticuz/chromium";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Browser resources pool
let browserInstance = null;
let browserLastUsed = null;

// Browser management
async function getBrowser() {
  const currentTime = Date.now();

  // Reuse browser if it exists and was used in the last 2 minutes
  if (
    browserInstance &&
    browserLastUsed &&
    currentTime - browserLastUsed < 120000
  ) {
    browserLastUsed = currentTime;
    return browserInstance;
  }

  // Close old browser if it exists
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      console.error("Error closing browser:", e);
    }
  }

  // Launch new browser with optimized settings
  browserInstance = await puppeteer.launch({
    args: [
      ...chrome.args,
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled", // Helps avoid detection
    ],
    defaultViewport: { width: 1024, height: 768 },
    executablePath: await chrome.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });

  // Add anti-detection measures
  const pages = await browserInstance.pages();
  if (pages.length > 0) {
    await pages[0].evaluateOnNewDocument(() => {
      // Pass basic bot detection
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      // Override Chrome/Puppeteer specific properties
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });
  }

  browserLastUsed = currentTime;
  return browserInstance;
}

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

// Optimized scraper with batch processing
async function scrapeCoupons(domain) {
  let browser = null;
  const BATCH_SIZE = 5; // Process coupons in batches of 5 (reduced from 10 for more reliability)
  const MAX_CONCURRENT = 3; // Maximum number of concurrent page operations
  const MODAL_TIMEOUT = 10000; // Timeout for modal processing in ms

  try {
    browser = await getBrowser();

    // Create a primary page for the initial scrape
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Enable JavaScript
    await page.setJavaScriptEnabled(true);

    // Set extra headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // Override the navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      // Pass basic bot detection
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      // Override Chrome/Puppeteer specific properties
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Selective resource blocking - block only unnecessary resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to CouponFollow with optimized settings
    const url = `https://couponfollow.com/site/${domain}`;
    console.log(`Navigating to ${url}...`);

    await page.goto(url, {
      waitUntil: "networkidle2", // Wait until network is idle for better JS execution
      timeout: 15000,
    });

    console.log(`Page loaded for ${domain}, extracting coupon data...`);

    // Wait for coupon elements with better error handling
    try {
      await page.waitForSelector(".offer-card.regular-offer", {
        timeout: 8000,
      });
    } catch (err) {
      console.log("Selector timeout, continuing with extraction");
    }

    // Extract basic coupon data with modal URLs
    const { basicCoupons, modalUrls } = await page.evaluate(() => {
      const basicCoupons = [];
      const modalUrls = [];
      let idCounter = 1;

      const couponElements = document.querySelectorAll(
        ".offer-card.regular-offer"
      );

      console.log(`Found ${couponElements.length} offer cards`);

      couponElements.forEach((element) => {
        // Skip if not a coupon
        const dataType = element.getAttribute("data-type");
        if (dataType !== "coupon") {
          console.log(
            `Skipping non-coupon element with data-type: ${dataType}`
          );
          return;
        }

        const discountEl = element.querySelector(".offer-title");
        const termsEl = element.querySelector(".offer-description");

        const discount = discountEl?.textContent?.trim() || "Discount";
        const terms = termsEl?.textContent?.trim() || "Terms apply";
        const verified = element.getAttribute("data-is-verified") === "True";

        // Extract direct code if available in the element
        let code = "AUTOMATIC";

        // Try to get code from clipboard data or other attributes
        const showCodeBtn = element.querySelector(".show-code");
        if (showCodeBtn) {
          const dataCode =
            showCodeBtn.getAttribute("data-code") ||
            showCodeBtn.getAttribute("data-clipboard-text");
          if (dataCode) {
            code = dataCode;
          }
        }

        // Get the direct modal URL (not the hash URL)
        const modalUrl = element.getAttribute("data-modal");

        // Store element ID for debugging
        const elementId = element.getAttribute("id") || `coupon-${idCounter}`;

        basicCoupons.push({
          id: idCounter++,
          code,
          discount,
          terms,
          verified,
          source: "CouponFollow",
          elementId, // Store element ID for reference
        });

        modalUrls.push(modalUrl);
      });

      return { basicCoupons, modalUrls };
    });

    console.log(
      `Found ${basicCoupons.length} basic coupons for ${domain}, processing modal URLs...`
    );

    // Process coupons with modal URLs to get the actual codes
    const completeCoupons = [...basicCoupons];

    // Process all coupons in batches
    if (modalUrls.length > 0) {
      const pendingCoupons = modalUrls
        .map((url, index) => ({
          url,
          index,
          coupon: basicCoupons[index],
        }))
        .filter((item) => item.url && item.coupon.code === "AUTOMATIC");

      const totalCoupons = pendingCoupons.length;
      const totalBatches = Math.ceil(totalCoupons / BATCH_SIZE);

      console.log(
        `Processing ${totalCoupons} modal URLs in ${totalBatches} batches of ${BATCH_SIZE}`
      );

      // Process in batches
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * BATCH_SIZE;
        const endIndex = Math.min(startIndex + BATCH_SIZE, totalCoupons);
        const currentBatchItems = pendingCoupons.slice(startIndex, endIndex);

        console.log(
          `Processing batch ${batchIndex + 1}/${totalBatches} (modals ${
            startIndex + 1
          }-${endIndex})`
        );

        await processModalBatch(
          browser,
          currentBatchItems,
          MAX_CONCURRENT,
          MODAL_TIMEOUT,
          completeCoupons
        );
      }
    }

    // Clean up and return coupons without internal properties
    return completeCoupons.map((coupon) => {
      const { elementId, ...cleanCoupon } = coupon;
      return cleanCoupon;
    });
  } catch (error) {
    console.error("Error in scrapeCoupons:", error);
    return []; // Return empty array instead of throwing
  }
}

// Process a batch of modals to extract coupon codes
async function processModalBatch(
  browser,
  batchItems,
  concurrentLimit,
  timeout,
  completeCoupons
) {
  // Create a page pool for this batch
  const pagePool = [];
  for (let i = 0; i < Math.min(batchItems.length, concurrentLimit); i++) {
    const modalPage = await browser.newPage();

    // Set a realistic user agent
    await modalPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36"
    );

    // Enable JavaScript
    await modalPage.setJavaScriptEnabled(true);

    // Additional anti-detection measures for modal page
    await modalPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
      window.navigator.chrome = { runtime: {} };
      window.navigator.permissions = {
        query: () => Promise.resolve({ state: "granted" }),
      };
    });

    // Selective resource blocking for modal pages
    await modalPage.setRequestInterception(true);
    modalPage.on("request", (req) => {
      const resourceType = req.resourceType();
      if (resourceType === "image" || resourceType === "font") {
        req.abort();
      } else {
        req.continue();
      }
    });

    pagePool.push(modalPage);
  }

  // Process each item in the batch with the page pool
  const batchPromises = [];

  for (let i = 0; i < batchItems.length; i++) {
    const item = batchItems[i];
    const modalPage = pagePool[i % pagePool.length]; // Cycle through the page pool

    batchPromises.push(
      (async () => {
        try {
          console.log(
            `Processing modal for coupon ${item.index + 1} (Element ID: ${
              item.coupon.elementId || "unknown"
            })`
          );

          // Navigate directly to the modal URL
          await modalPage.goto(item.url, {
            waitUntil: ["load", "domcontentloaded"],
            timeout: timeout,
          });

          // Wait for potential code input fields to load
          try {
            await modalPage.waitForSelector(
              "input#code.input.code, input.input.code, .coupon-code, .code-text, [data-clipboard-text], [data-code]",
              {
                timeout: 5000,
              }
            );
          } catch (err) {
            console.log(
              `No code input found for modal ${item.index + 1}`,
              "WARN"
            );
          }

          // Add a small delay to ensure dynamic content is loaded
          await modalPage.evaluate(() => {
            return new Promise((resolve) => setTimeout(resolve, 500));
          });

          // Extract the code from the modal using multiple approaches
          const code = await modalPage.evaluate(() => {
            // Try various selectors to find the code
            const selectors = [
              "input#code.input.code",
              "input.input.code",
              ".coupon-code",
              ".code-text",
              "[data-clipboard-text]",
              "[data-code]",
            ];

            // Try the selectors in order
            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (!element) continue;

              // Handle different element types
              if (element.tagName === "INPUT") {
                const value = element.value.trim();
                if (value) return value;
              } else {
                // For non-input elements, try data attributes first
                const clipboardText = element.getAttribute(
                  "data-clipboard-text"
                );
                if (clipboardText) return clipboardText.trim();

                const dataCode = element.getAttribute("data-code");
                if (dataCode) return dataCode.trim();

                // Last resort: use text content
                const textContent = element.textContent.trim();
                if (textContent) return textContent;
              }
            }

            // Return a Promise that resolves after a delay to try again
            return new Promise((resolve) => {
              setTimeout(() => {
                // Try once more after a short delay
                for (const selector of selectors) {
                  const element = document.querySelector(selector);
                  if (!element) continue;

                  if (element.tagName === "INPUT") {
                    const value = element.value.trim();
                    if (value) {
                      resolve(value);
                      return;
                    }
                  } else {
                    const clipboardText = element.getAttribute(
                      "data-clipboard-text"
                    );
                    if (clipboardText) {
                      resolve(clipboardText.trim());
                      return;
                    }

                    const dataCode = element.getAttribute("data-code");
                    if (dataCode) {
                      resolve(dataCode.trim());
                      return;
                    }

                    const textContent = element.textContent.trim();
                    if (textContent) {
                      resolve(textContent);
                      return;
                    }
                  }
                }

                resolve("AUTOMATIC"); // Default if no code found
              }, 500); // Wait 500ms before trying again
            });
          });

          // Update the coupon with the extracted code
          if (code && code !== "AUTOMATIC") {
            completeCoupons[item.index].code = code;
            console.log(
              `Found code ${code} for coupon ${item.index + 1} (ID: ${
                item.coupon.elementId || "unknown"
              })`
            );
          } else {
            console.log(
              `No code found for coupon ${item.index + 1} (ID: ${
                item.coupon.elementId || "unknown"
              })`,
              "WARN"
            );
          }
        } catch (error) {
          console.error(
            `Error processing modal for coupon ${item.index + 1}:`,
            error
          );
        }
      })()
    );
  }

  // Wait for all modals in this batch to complete
  await Promise.all(batchPromises);

  // Close all pages in the pool
  for (const modalPage of pagePool) {
    await modalPage
      .close()
      .catch((err) => console.error("Error closing modal page:", err));
  }
}
