const { chromium } = require("playwright");

(async () => {
  const publicUrl = process.argv[2] || "https://wohnen.wohnquartier-geseke-west.de/";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const testId = `BROWSER-${stamp}`;
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const captured = { testId, publicUrl, requests: [], responses: [] };
  page.on("request", (request) => {
    if (!request.url().startsWith("https://formsubmit.co/")) return;
    const headers = request.headers();
    captured.requests.push({ url: request.url(), method: request.method(), contentType: headers["content-type"] || null, postData: request.postData() });
  });
  page.on("response", (response) => {
    if (response.url().startsWith("https://formsubmit.co/")) captured.responses.push({ url: response.url(), status: response.status() });
  });
  await page.goto(publicUrl, { waitUntil: "networkidle", timeout: 60_000 });
  captured.loadedUrl = page.url();
  captured.formBeforeSubmit = await page.locator("form[data-lead-form]").evaluate((form) => ({
    action: form.action,
    method: form.method,
    enctype: form.enctype,
    webhook: form.querySelector('[name="_webhook"]')?.value,
    fieldNames: Array.from(new FormData(form).keys()),
  }));
  await page.selectOption('[name="Anrede"]', { label: "Keine Angabe" });
  await page.fill('[name="Vorname"]', "TECHNISCHER TEST");
  await page.fill('[name="Nachname"]', "NICHT BEARBEITEN");
  await page.fill('[name="E-Mail"]', "qa-test@example.com");
  await page.fill('[name="Telefon"]', "+49 111 111111");
  await page.fill('[name="Nachricht"]', `TEST - real public browser flow - ${testId}`);
  await page.check('[name="Einwilligung akzeptiert"]');
  captured.formDataAtSubmit = await page.locator("form[data-lead-form]").evaluate((form) => Object.fromEntries(new FormData(form).entries()));
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null),
    page.locator('form[data-lead-form] button[type="submit"]').click(),
  ]);
  await page.waitForTimeout(2_000);
  captured.finalUrl = page.url();
  captured.finalTitle = await page.title();
  captured.bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240);
  console.log(JSON.stringify(captured, null, 2));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
