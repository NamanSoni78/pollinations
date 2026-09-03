#!/usr/bin/env python3
"""
Pollinations AI GIMP 3 Plug-in
Provides Pollinations image generation and image-to-image editing directly inside GIMP 3.
Uses BYOP Device Flow authorization, dynamic model discovery, capability-driven UI controls,
and seamless layer/image extraction and insertion.
"""

import sys
import os
import pathlib
import threading
import time
import tempfile
import webbrowser

# Add current plugin directory to sys.path to ensure module imports
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from pollinations_core import (
    PollinationsClient,
    PollinationsError,
    AuthenticationError,
    InsufficientPollenError,
)

# PyGObject GIMP 3 / GTK imports
# Handled gracefully if executed outside GIMP environment
try:
    import gi
    gi.require_version('Gimp', '3.0')
    gi.require_version('GimpUi', '3.0')
    gi.require_version('Gtk', '3.0')
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import Gimp, GimpUi, Gtk, GdkPixbuf, GObject, Gio, Gegl
    GIMP_AVAILABLE = True
except Exception:
    GIMP_AVAILABLE = False


class PollinationsPluginDialog:
    """GTK User Interface Dialog for Pollinations GIMP 3 Integration."""

    def __init__(self, client, image=None, drawables=None):
        self.client = client
        self.image = image
        self.drawables = drawables or []
        self.models = []
        self.selected_model = None
        self.polling_thread = None
        self.polling_active = False

        self.dialog = Gtk.Dialog(
            title="Pollinations AI Generator & Editor",
            flags=0
        )
        self.dialog.set_default_size(520, 680)
        self.dialog.add_button("_Close", Gtk.ResponseType.CLOSE)
        self.generate_btn = self.dialog.add_button("_Generate", Gtk.ResponseType.OK)
        self.dialog.set_default_response(Gtk.ResponseType.OK)

        content_area = self.dialog.get_content_area()
        content_area.set_spacing(10)
        content_area.set_border_width(12)

        # 1. Account / Auth Section
        auth_frame = Gtk.Frame(label=" Pollinations Account (BYOP) ")
        auth_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        auth_box.set_border_width(8)
        auth_frame.add(auth_box)
        content_area.pack_start(auth_frame, False, False, 0)

        self.auth_status_label = Gtk.Label(align=0.0)
        auth_box.pack_start(self.auth_status_label, False, False, 0)

        auth_btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.connect_btn = Gtk.Button(label="Connect Pollinations Account")
        self.connect_btn.connect("clicked", self.on_connect_clicked)
        auth_btn_box.pack_start(self.connect_btn, True, True, 0)

        self.disconnect_btn = Gtk.Button(label="Disconnect")
        self.disconnect_btn.connect("clicked", self.on_disconnect_clicked)
        auth_btn_box.pack_start(self.disconnect_btn, False, False, 0)

        auth_box.pack_start(auth_btn_box, False, False, 0)

        # 2. Model Selection
        model_frame = Gtk.Frame(label=" Model Selection ")
        model_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        model_box.set_border_width(8)
        model_frame.add(model_box)
        content_area.pack_start(model_frame, False, False, 0)

        model_combo_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        model_combo_box.pack_start(Gtk.Label(label="Model:", xalign=0), False, False, 0)

        self.model_combo = Gtk.ComboBoxText()
        self.model_combo.connect("changed", self.on_model_changed)
        model_combo_box.pack_start(self.model_combo, True, True, 0)

        self.refresh_models_btn = Gtk.Button(label="↻")
        self.refresh_models_btn.set_tooltip_text("Refresh live models from Pollinations")
        self.refresh_models_btn.connect("clicked", lambda b: self.load_models())
        model_combo_box.pack_start(self.refresh_models_btn, False, False, 0)

        model_box.pack_start(model_combo_box, False, False, 0)

        self.model_desc_label = Gtk.Label(xalign=0)
        self.model_desc_label.set_line_wrap(True)
        model_box.pack_start(self.model_desc_label, False, False, 0)

        # 3. Generation Options & Prompt
        options_frame = Gtk.Frame(label=" Prompt & Options ")
        options_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        options_box.set_border_width(8)
        options_frame.add(options_box)
        content_area.pack_start(options_frame, True, True, 0)

        options_box.pack_start(Gtk.Label(label="Prompt:", xalign=0), False, False, 0)
        self.prompt_scrolled = Gtk.ScrolledWindow()
        self.prompt_scrolled.set_min_content_height(80)
        self.prompt_text = Gtk.TextView()
        self.prompt_text.set_wrap_mode(Gtk.WrapMode.WORD)
        self.prompt_scrolled.add(self.prompt_text)
        options_box.pack_start(self.prompt_scrolled, True, True, 0)

        # Dimensions & Seed Controls
        grid = Gtk.Grid()
        grid.set_column_spacing(10)
        grid.set_row_spacing(8)
        options_box.pack_start(grid, False, False, 0)

        grid.attach(Gtk.Label(label="Width:", xalign=1), 0, 0, 1, 1)
        self.width_spin = Gtk.SpinButton.new_with_range(64, 4096, 64)
        self.width_spin.set_value(1024)
        grid.attach(self.width_spin, 1, 0, 1, 1)

        grid.attach(Gtk.Label(label="Height:", xalign=1), 2, 0, 1, 1)
        self.height_spin = Gtk.SpinButton.new_with_range(64, 4096, 64)
        self.height_spin.set_value(1024)
        grid.attach(self.height_spin, 3, 0, 1, 1)

        grid.attach(Gtk.Label(label="Seed (optional):", xalign=1), 0, 1, 1, 1)
        self.seed_entry = Gtk.Entry()
        self.seed_entry.set_placeholder_text("Random")
        grid.attach(self.seed_entry, 1, 1, 3, 1)

        # Mode Selection: New Image vs New Layer vs Edit Active Layer
        mode_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        mode_box.pack_start(Gtk.Label(label="Output Mode:", xalign=0), False, False, 0)

        self.mode_new_image = Gtk.RadioButton.new_with_label(None, "Create New Image")
        self.mode_new_layer = Gtk.RadioButton.new_with_label_from_widget(self.mode_new_image, "Add as New Layer in Active Image")
        self.mode_edit_layer = Gtk.RadioButton.new_with_label_from_widget(self.mode_new_image, "Edit Active Layer/Selection (Image-to-Image)")

        mode_box.pack_start(self.mode_new_image, False, False, 0)
        mode_box.pack_start(self.mode_new_layer, False, False, 0)
        mode_box.pack_start(self.mode_edit_layer, False, False, 0)

        if not self.image:
            self.mode_new_layer.set_sensitive(False)
            self.mode_edit_layer.set_sensitive(False)
            self.mode_new_image.set_active(True)
        else:
            self.mode_new_layer.set_active(True)

        options_box.pack_start(mode_box, False, False, 0)

        # 4. Status Bar & Error Recovery Message
        self.status_label = Gtk.Label(label="Ready", xalign=0)
        content_area.pack_start(self.status_label, False, False, 0)

        self.update_auth_ui()
        self.load_models()

        self.dialog.show_all()

    def update_auth_ui(self):
        if self.client.is_connected():
            user = self.client.get_saved_user()
            username = user.get("preferred_username") or user.get("sub") or "Connected Account"
            self.auth_status_label.set_markup(f"Status: <b>Connected</b> as <i>{username}</i>")
            self.connect_btn.set_sensitive(False)
            self.disconnect_btn.set_sensitive(True)
            self.generate_btn.set_sensitive(True)
        else:
            self.auth_status_label.set_markup("Status: <b>Not connected</b>")
            self.connect_btn.set_sensitive(True)
            self.disconnect_btn.set_sensitive(False)
            self.generate_btn.set_sensitive(False)

    def on_connect_clicked(self, btn):
        try:
            device_res = self.client.start_device_flow()
            user_code = device_res.get("user_code", "")
            verification_url = device_res.get("verification_url_full", "https://enter.pollinations.ai/device")
            device_code = device_res.get("device_code")

            # Open browser automatically
            webbrowser.open(verification_url)

            # Show dialog with user code
            msg_dialog = Gtk.MessageDialog(
                transient_for=self.dialog,
                flags=0,
                message_type=Gtk.MessageType.INFO,
                buttons=Gtk.ButtonsType.OK,
                text="Pollinations Account Connection"
            )
            msg_dialog.format_secondary_text(
                f"Your browser should open automatically.\n\n"
                f"User Code: {user_code}\n\n"
                f"If the browser did not open, navigate to:\n{verification_url}\n\n"
                f"Click OK after confirming access in your browser."
            )
            msg_dialog.run()
            msg_dialog.destroy()

            # Start polling background thread
            self.status_label.set_text("Waiting for user authorization in browser...")
            self.start_token_polling(device_code)

        except Exception as e:
            self.show_error_dialog("Connection Error", str(e))

    def start_token_polling(self, device_code):
        self.polling_active = True
        def poll_loop():
            attempts = 0
            while self.polling_active and attempts < 60:
                time.sleep(3)
                try:
                    res = self.client.poll_device_token(device_code)
                    if "access_token" in res:
                        GObject.idle_add(self.on_poll_success)
                        break
                except AuthenticationError as e:
                    GObject.idle_add(self.show_error_dialog, "Auth Error", str(e))
                    break
                except Exception:
                    pass
                attempts += 1
            self.polling_active = False

        self.polling_thread = threading.Thread(target=poll_loop, daemon=True)
        self.polling_thread.start()

    def on_poll_success(self):
        self.update_auth_ui()
        self.status_label.set_text("Successfully connected Pollinations account!")

    def on_disconnect_clicked(self, btn):
        self.client.disconnect()
        self.update_auth_ui()
        self.status_label.set_text("Disconnected account.")

    def load_models(self):
        self.status_label.set_text("Fetching live model catalog...")
        def fetch():
            try:
                models = self.client.fetch_models()
                GObject.idle_add(self.populate_models, models)
            except Exception as e:
                GObject.idle_add(self.status_label.set_text, f"Failed to load models: {e}")

        threading.Thread(target=fetch, daemon=True).start()

    def populate_models(self, models):
        self.models = models
        self.model_combo.remove_all()
        for idx, m in enumerate(models):
            title = m.get("title", m["id"])
            if m.get("community"):
                title += " (Community)"
            self.model_combo.append_text(title)

        if models:
            self.model_combo.set_active(0)
            self.status_label.set_text(f"Loaded {len(models)} models.")
        else:
            self.status_label.set_text("No models found.")

    def on_model_changed(self, combo):
        idx = combo.get_active()
        if idx >= 0 and idx < len(self.models):
            m = self.models[idx]
            self.selected_model = m
            supports_img = m.get("supports_image_input", False)
            desc = m.get("description", "")
            mods = ", ".join(m.get("input_modalities", ["text"]))
            self.model_desc_label.set_text(f"Modalities: [{mods}]\n{desc}")

            # Capability-driven control: enable/disable Edit Active Layer if unsupported
            if not supports_img:
                self.mode_edit_layer.set_sensitive(False)
                if self.mode_edit_layer.get_active():
                    self.mode_new_layer.set_active(True)
            else:
                if self.image:
                    self.mode_edit_layer.set_sensitive(True)

    def show_error_dialog(self, title, message):
        dialog = Gtk.MessageDialog(
            transient_for=self.dialog,
            flags=0,
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.OK,
            text=title
        )
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()


def export_active_layer_png(image, drawable):
    """Exports current active layer/selection in GIMP 3 to PNG bytes."""
    if not GIMP_AVAILABLE or not image or not drawable:
        return None

    try:
        temp_file = Gio.File.new_for_path(os.path.join(tempfile.gettempdir(), f"gimp_polli_input_{int(time.time())}.png"))
        # GIMP 3 procedure to save PNG
        proc = Gimp.get_pdb().lookup_procedure('gimp-file-save')
        config = proc.create_config()
        config.set_property('run-mode', Gimp.RunMode.NONINTERACTIVE)
        config.set_property('image', image)
        config.set_property('file', temp_file)
        config.set_property('num-drawables', 1)
        config.set_property('drawables', Gimp.ObjectArray.new(Gimp.Drawable, [drawable], False))

        proc.run(config)

        path = temp_file.get_path()
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = f.read()
            os.remove(path)
            return data
    except Exception as e:
        print(f"[Pollinations GIMP Plugin] Error exporting layer: {e}")
    return None


def import_png_to_gimp(png_bytes, mode="new_image", image=None):
    """Imports generated PNG bytes into GIMP 3 as a new Image or new Layer."""
    if not GIMP_AVAILABLE:
        return None

    try:
        temp_path = os.path.join(tempfile.gettempdir(), f"gimp_polli_output_{int(time.time())}.png")
        with open(temp_path, "wb") as f:
            f.write(png_bytes)

        temp_file = Gio.File.new_for_path(temp_path)

        if mode == "new_image" or not image:
            new_img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, temp_file)
            display = Gimp.Display.new(new_img)
            os.remove(temp_path)
            return new_img
        else:
            # Add as new layer to existing image
            loaded_img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, temp_file)
            layers = loaded_img.get_layers()
            if layers:
                src_layer = layers[0]
                new_layer = Gimp.Layer.new_from_drawable(src_layer, image)
                new_layer.set_name("Pollinations AI")
                image.insert_layer(new_layer, None, 0)
                Gimp.displays_flush()
            loaded_img.delete()
            os.remove(temp_path)
            return image
    except Exception as e:
        print(f"[Pollinations GIMP Plugin] Error importing layer: {e}")
        return None


if GIMP_AVAILABLE:
    class PollinationsGimpPlugin(Gimp.PlugIn):
        """GIMP 3 Plugin procedure registration."""

        def do_query_procedures(self):
            return ["pollinations-ai-generate"]

        def do_create_procedure(self, name):
            procedure = Gimp.ImageProcedure.new(
                self,
                name,
                Gimp.PdbProcType.PLUGIN,
                self.run,
                None
            )
            procedure.set_image_types("*")
            procedure.set_sensitivity_mask(Gimp.ProcedureSensitivity.ALWAYS)
            procedure.set_menu_label("Pollinations AI Generator & Editor...")
            procedure.add_menu_path("<Image>/Filters/Render/")
            procedure.set_documentation(
                "Generate or edit images with Pollinations AI models",
                "Connects to Pollinations AI using BYOP Device Flow to generate or edit active layers.",
                name
            )
            procedure.set_attribution("Pollinations AI", "Pollinations AI", "2025")
            return procedure

        def run(self, procedure, run_mode, image, drawables, config, data):
            GimpUi.init("pollinations_gimp.py")

            client = PollinationsClient()
            dialog = PollinationsPluginDialog(client, image, drawables)

            response = dialog.dialog.run()

            if response == Gtk.ResponseType.OK:
                # User clicked Generate
                prompt_buf = dialog.prompt_text.get_buffer()
                prompt = prompt_buf.get_text(prompt_buf.get_start_iter(), prompt_buf.get_end_iter(), False)

                if not prompt.strip():
                    dialog.show_error_dialog("Prompt Error", "Please enter a text prompt.")
                    dialog.dialog.destroy()
                    return procedure.new_return_values(Gimp.PdbStatusType.SUCCESS, None)

                model_info = dialog.selected_model or {}
                model_id = model_info.get("id", "flux")
                width = int(dialog.width_spin.get_value())
                height = int(dialog.height_spin.get_value())
                seed_str = dialog.seed_entry.get_text().strip()
                seed = int(seed_str) if seed_str.isdigit() else None

                input_bytes = None
                if dialog.mode_edit_layer.get_active() and image and drawables:
                    input_bytes = export_active_layer_png(image, drawables[0])

                dialog.status_label.set_text("Generating image with Pollinations AI...")

                try:
                    png_bytes = client.generate_image(
                        prompt=prompt,
                        model=model_id,
                        width=width,
                        height=height,
                        seed=seed,
                        input_image_bytes=input_bytes
                    )

                    mode = "new_image"
                    if dialog.mode_new_layer.get_active() or dialog.mode_edit_layer.get_active():
                        mode = "new_layer"

                    import_png_to_gimp(png_bytes, mode=mode, image=image)

                except PollinationsError as e:
                    dialog.show_error_dialog("Pollinations AI Error", str(e))
                except Exception as e:
                    dialog.show_error_dialog("Unexpected Error", f"An error occurred: {e}")

            dialog.dialog.destroy()
            return procedure.new_return_values(Gimp.PdbStatusType.SUCCESS, None)

    Gimp.main(PollinationsGimpPlugin.__gtype__, sys.argv)
