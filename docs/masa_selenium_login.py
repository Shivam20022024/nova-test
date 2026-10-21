"""
Plain Selenium login attempt for https://dev.masa.life  (experiment: "can Selenium log in?")

What it does: opens the login page, types the email + password, clicks Sign in, then
reports clearly what happened. It does NOT use stealth plugins, undetected drivers or any
CAPTCHA/Turnstile solver - it behaves like an ordinary automated Chrome. If Cloudflare
Turnstile refuses automated browsers, the script will say so rather than work around it.

Setup (once):
    pip install selenium            # Selenium 4.6+ downloads the matching chromedriver itself

Credentials are NOT stored in this file. Either set env vars:
    PowerShell:  $env:MASA_EMAIL="you@example.com"; $env:MASA_PASSWORD="..."
or just run it and type them at the prompt (the password prompt is hidden).

Run:
    python masa_selenium_login.py                 # visible Chrome window (default)
    python masa_selenium_login.py --headless      # no window (more likely to be refused)
    python masa_selenium_login.py --human-check   # if Turnstile shows a box, YOU click it,
                                                  # then the script carries on

Result is printed as one of:
    LOGIN_OK                -> reached the signed-in app (Today/Journey navigation visible)
    BLOCKED_BY_TURNSTILE    -> the site's security check never completed for this browser
    BAD_CREDENTIALS         -> the site rejected the email/password
    UNKNOWN                 -> still on the login page with no recognisable message
A screenshot (masa_login_result.png) and the final URL are saved for evidence.
"""
import argparse
import getpass
import os
import sys
import time

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

LOGIN_URL = "https://dev.masa.life/login"
SHOT = "masa_login_result.png"


def build_driver(headless: bool) -> webdriver.Chrome:
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1280,900")
    return webdriver.Chrome(options=opts)  # Selenium Manager resolves chromedriver


def page_text(driver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, "body").text.lower()
    except NoSuchElementException:
        return ""


def logged_in(driver) -> bool:
    # Signed-in app shows the main nav (Today / Journey / Care / More); login page does not.
    return bool(driver.find_elements(By.CSS_SELECTOR, "a[href='/journey'], a[href='/care']")) \
        and "/login" not in driver.current_url


def turnstile_token(driver) -> str:
    """Value of the hidden field the page fills in once its own security check passes."""
    try:
        return driver.find_element(By.CSS_SELECTOR, "input[name='cf-turnstile-response']").get_attribute("value") or ""
    except NoSuchElementException:
        return ""


def classify(driver) -> str:
    if logged_in(driver):
        return "LOGIN_OK"
    text = page_text(driver)
    # Site is still running / has refused its security check for this browser.
    blocked_phrases = ("checking this browser", "security check", "couldn't run",
                       "verify you are human", "check wasn't completed", "please complete it")
    if any(p in text for p in blocked_phrases):
        return "TURNSTILE_PENDING_OR_BLOCKED"
    if any(s in text for s in ("invalid email or password", "incorrect", "wrong password", "invalid login")):
        return "BAD_CREDENTIALS"
    return "UNKNOWN"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headless", action="store_true", help="run Chrome without a window")
    ap.add_argument("--human-check", action="store_true",
                    help="pause so a person can complete the Turnstile box, then continue")
    args = ap.parse_args()

    email = os.environ.get("MASA_EMAIL") or input("Masa email: ").strip()
    password = os.environ.get("MASA_PASSWORD") or getpass.getpass("Masa password (hidden): ")

    driver = build_driver(args.headless)
    wait = WebDriverWait(driver, 20)
    try:
        driver.get(LOGIN_URL)
        email_box = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input[type='email']")))
        pass_box = driver.find_element(By.CSS_SELECTOR, "input[type='password']")
        email_box.clear(); email_box.send_keys(email)
        pass_box.clear(); pass_box.send_keys(password)

        if args.human_check and not args.headless:
            input("If a security check box is showing, complete it in the browser, then press Enter here...")

        # The page runs its own Turnstile check in the background and only enables Sign in
        # once it has a token. Just wait for that (up to 45s) - we do not touch the check.
        token_ready = False
        for _ in range(45):
            if turnstile_token(driver):
                token_ready = True
                break
            time.sleep(1)
        print(f"Security check token received from the page: {token_ready}")

        # The page has a "Sign in" tab AND a submit button; the submit one lives in the form.
        submit = driver.find_element(By.CSS_SELECTOR, "form button[type='submit']")
        submit.click()

        # Wait up to 25s for either the signed-in app or a recognisable error.
        deadline = time.time() + 25
        result = "UNKNOWN"
        while time.time() < deadline:
            result = classify(driver)
            if result in ("LOGIN_OK", "BAD_CREDENTIALS"):
                break
            time.sleep(1)
        if result == "TURNSTILE_PENDING_OR_BLOCKED" and not token_ready:
            result = "BLOCKED_BY_TURNSTILE (the page never received a security-check token)"

        driver.save_screenshot(SHOT)
        print(f"\nRESULT : {result}")
        print(f"URL    : {driver.current_url}")
        print(f"SHOT   : {os.path.abspath(SHOT)}")
        return 0 if result == "LOGIN_OK" else 1
    except TimeoutException:
        driver.save_screenshot(SHOT)
        print("RESULT : UNKNOWN (login form did not appear in time)")
        print(f"URL    : {driver.current_url}\nSHOT   : {os.path.abspath(SHOT)}")
        return 2
    finally:
        driver.quit()


if __name__ == "__main__":
    sys.exit(main())
