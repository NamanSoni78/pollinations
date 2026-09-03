#!/usr/bin/env python3
"""
Standalone CLI Demo & Test Harness for Pollinations GIMP 3 Plugin.
Demonstrates the BYOP Device Flow auth, model discovery, and image generation/editing functionality.
"""

import sys
import os
import time

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from pollinations_core import PollinationsClient, PollinationsError

def main():
    print("==================================================")
    print(" Pollinations AI GIMP 3 Plug-in CLI Test Harness ")
    print("==================================================")

    client = PollinationsClient()

    if client.is_connected():
        user = client.get_saved_user()
        username = user.get("preferred_username") or user.get("sub") or "Authorized User"
        print(f"\n[+] Currently connected as: {username}")
    else:
        print("\n[!] Not connected to Pollinations.")
        ans = input("Do you want to start BYOP Device Flow authorization? [y/N]: ").strip().lower()
        if ans == 'y':
            try:
                device_info = client.start_device_flow()
                print("\n--------------------------------------------------")
                print(f"User Code:         {device_info.get('user_code')}")
                print(f"Verification URL:  {device_info.get('verification_url_full')}")
                print("--------------------------------------------------")
                print("Please open the URL in your browser and authorize access.")
                print("Polling for user approval (press Ctrl+C to cancel)...")

                while True:
                    time.sleep(4)
                    res = client.poll_device_token(device_info.get("device_code"))
                    if "access_token" in res:
                        print("\n[+] Success! Account connected.")
                        break
                    elif res.get("status") == "pending":
                        print(".", end="", flush=True)
            except KeyboardInterrupt:
                print("\n[!] Auth cancelled.")
                return
            except PollinationsError as e:
                print(f"\n[-] Error: {e}")
                return

    print("\n[1] Fetching Live Model Catalog...")
    try:
        models = client.fetch_models()
        print(f"[+] Loaded {len(models)} image models.")
        print("\nSample Models Available:")
        for m in models[:5]:
            img_supp = " [Image-to-Image Supported]" if m.get("supports_image_input") else ""
            comm = " (Community)" if m.get("community") else ""
            print(f"  - {m['id']} ({m['title']}){comm}{img_supp}")
    except Exception as e:
        print(f"[-] Failed to fetch models: {e}")
        return

    print("\n[2] Testing Image Generation API...")
    if not client.is_connected():
        print("[!] Cannot run generation test without active connection.")
        return

    prompt = "A majestic glowing waterfall in a mystical purple forest, digital art"
    print(f"Prompt: '{prompt}'")
    try:
        print("Sending request to Pollinations...")
        png_bytes = client.generate_image(prompt=prompt, model="flux", width=512, height=512)
        out_file = "test_output.png"
        with open(out_file, "wb") as f:
            f.write(png_bytes)
        print(f"[+] Successfully generated image and saved to '{out_file}' ({len(png_bytes)} bytes)!")
    except PollinationsError as e:
        print(f"[-] Pollinations API Error: {e}")
    except Exception as e:
        print(f"[-] Unexpected Error: {e}")

if __name__ == "__main__":
    main()
