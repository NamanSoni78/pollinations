import threading
import webbrowser
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GimpUi", "3.0")
from gi.repository import Gtk, Gdk, GLib, GimpUi

class PollinationsDialog(Gtk.Dialog):
    """GTK 3 dialog interface for Pollinations AI inside GIMP 3."""

    def __init__(self, parent, api_client, auth_manager):
        super().__init__(
            title="Pollinations AI Generator",
            transient_for=parent,
            flags=0
        )
        self.api_client = api_client
        self.auth_manager = auth_manager
        self.models = []
        self.selected_model = None

        self.set_default_size(520, 500)
        self.add_button("Cancel", Gtk.ResponseType.CANCEL)
        self.generate_btn = self.add_button("Generate", Gtk.ResponseType.OK)

        self.build_ui()
        self.refresh_auth_status()

    def build_ui(self):
        content_area = self.get_content_area()
        content_area.set_spacing(10)
        content_area.set_border_width(12)

        # 1. Auth Header / Status Frame
        auth_frame = Gtk.Frame(label=" Pollinations Account ")
        auth_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        auth_box.set_border_width(8)

        self.auth_label = Gtk.Label(label="Checking account connection...")
        self.auth_label.set_halign(Gtk.Align.START)
        auth_box.pack_start(self.auth_label, True, True, 0)

        self.auth_btn = Gtk.Button(label="Connect Account")
        self.auth_btn.connect("clicked", self.on_auth_btn_clicked)
        auth_box.pack_end(self.auth_btn, False, False, 0)

        auth_frame.add(auth_box)
        content_area.pack_start(auth_frame, False, False, 0)

        # 2. Controls Grid
        grid = Gtk.Grid()
        grid.set_column_spacing(10)
        grid.set_row_spacing(10)
        content_area.pack_start(grid, True, True, 0)

        # Prompt
        grid.attach(Gtk.Label(label="Prompt:", halign=Gtk.Align.END), 0, 0, 1, 1)
        self.prompt_entry = Gtk.Entry()
        self.prompt_entry.set_placeholder_text("Describe the image you want to generate or edit...")
        grid.attach(self.prompt_entry, 1, 0, 1, 1)

        # Model Picker
        grid.attach(Gtk.Label(label="Model:", halign=Gtk.Align.END), 0, 1, 1, 1)
        self.model_combo = Gtk.ComboBoxText()
        self.model_combo.connect("changed", self.on_model_changed)
        grid.attach(self.model_combo, 1, 1, 1, 1)

        # Model Info / Capability Label
        self.model_info_label = Gtk.Label()
        self.model_info_label.set_line_wrap(True)
        self.model_info_label.set_halign(Gtk.Align.START)
        grid.attach(self.model_info_label, 1, 2, 1, 1)

        # Dimensions
        grid.attach(Gtk.Label(label="Width:", halign=Gtk.Align.END), 0, 3, 1, 1)
        self.width_spin = Gtk.SpinButton.new_with_range(256, 2048, 64)
        self.width_spin.set_value(1024)
        grid.attach(self.width_spin, 1, 3, 1, 1)

        grid.attach(Gtk.Label(label="Height:", halign=Gtk.Align.END), 0, 4, 1, 1)
        self.height_spin = Gtk.SpinButton.new_with_range(256, 2048, 64)
        self.height_spin.set_value(1024)
        grid.attach(self.height_spin, 1, 4, 1, 1)

        # Destination Mode
        grid.attach(Gtk.Label(label="Output Target:", halign=Gtk.Align.END), 0, 5, 1, 1)
        self.target_combo = Gtk.ComboBoxText()
        self.target_combo.append("new_layer", "Add as New Layer")
        self.target_combo.append("new_image", "Open as New Image")
        self.target_combo.set_active(0)
        grid.attach(self.target_combo, 1, 5, 1, 1)

        # 3. Status Bar
        self.status_label = Gtk.Label(label="Ready")
        self.status_label.set_halign(Gtk.Align.START)
        content_area.pack_start(self.status_label, False, False, 0)

        self.show_all()

    def refresh_auth_status(self):
        token = self.auth_manager.get_token()
        self.api_client.token = token
        if token:
            self.auth_label.set_text("Connected via Pollinations BYOP")
            self.auth_btn.set_label("Disconnect")
        else:
            self.auth_label.set_text("Not Connected (Using anonymous mode)")
            self.auth_btn.set_label("Connect Account")

        # Load models in background
        threading.Thread(target=self.load_models_async, daemon=True).start()

    def on_auth_btn_clicked(self, widget):
        token = self.auth_manager.get_token()
        if token:
            self.auth_manager.clear_auth()
            self.status_label.set_text("Disconnected from Pollinations.")
            self.refresh_auth_status()
        else:
            self.start_byop_connect()

    def start_byop_connect(self):
        self.auth_btn.set_sensitive(False)
        self.status_label.set_text("Requesting device code...")

        def _auth_thread():
            try:
                device_data = self.api_client.start_device_flow()
                user_code = device_data.get("user_code")
                verify_uri = device_data.get("verification_uri_complete") or device_data.get("verification_uri")
                device_code = device_data.get("device_code")

                GLib.idle_add(self.status_label.set_text, f"Opening browser... Code: {user_code}")
                if verify_uri:
                    webbrowser.open(verify_uri)

                token_data = self.api_client.poll_device_token(device_code)
                self.auth_manager.save_auth(token_data)

                GLib.idle_add(self.status_label.set_text, "Account successfully connected!")
                GLib.idle_add(self.refresh_auth_status)
            except Exception as e:
                GLib.idle_add(self.status_label.set_text, f"Auth Error: {str(e)}")
            finally:
                GLib.idle_add(self.auth_btn.set_sensitive, True)

        threading.Thread(target=_auth_thread, daemon=True).start()

    def load_models_async(self):
        try:
            GLib.idle_add(self.status_label.set_text, "Loading model catalog...")
            models = self.api_client.fetch_image_models()
            GLib.idle_add(self.populate_models, models)
        except Exception as e:
            GLib.idle_add(self.status_label.set_text, f"Error loading models: {str(e)}")

    def populate_models(self, models):
        self.models = models
        self.model_combo.remove_all()

        default_idx = 0
        for idx, m in enumerate(models):
            badge = "[Community] " if m.get("community") else ""
            edit_badge = " [Image Edit]" if m.get("supports_image_input") else ""
            title = f"{badge}{m['title']}{edit_badge}"
            self.model_combo.append(m["id"], title)
            if m["id"] in ("zimage", "flux"):
                default_idx = idx

        if models:
            self.model_combo.set_active(default_idx)
            self.status_label.set_text(f"Loaded {len(models)} image models.")

    def on_model_changed(self, combo):
        model_id = combo.get_active_id()
        if not model_id:
            return
        selected = next((m for m in self.models if m["id"] == model_id), None)
        self.selected_model = selected
        if selected:
            desc = selected.get("description") or "Standard image generation model."
            edits = "Supports Image Input / Inpainting." if selected.get("supports_image_input") else "Text-to-Image only."
            self.model_info_label.set_text(f"{desc}\n({edits})")

    def get_user_options(self):
        return {
            "prompt": self.prompt_entry.get_text(),
            "model": self.model_combo.get_active_id() or "zimage",
            "width": int(self.width_spin.get_value()),
            "height": int(self.height_spin.get_value()),
            "target": self.target_combo.get_active_id() or "new_layer",
            "selected_model": self.selected_model
        }
