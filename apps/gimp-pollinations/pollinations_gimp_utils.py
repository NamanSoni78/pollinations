import tempfile
import os
import gi

gi.require_version("Gimp", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gimp, GdkPixbuf, GLib

def export_drawable_to_png_bytes(image, drawable) -> bytes:
    """Exports a GIMP drawable or selection to PNG binary bytes."""
    temp_file = os.path.join(tempfile.gettempdir(), f"gimp_polli_input_{os.getpid()}.png")
    try:
        gio_file = Gio.File.new_for_path(temp_file)
        # In GIMP 3, file export procedure can be retrieved or layer exported
        Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, image, drawable, gio_file)
        with open(temp_file, "rb") as f:
            data = f.read()
        return data
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception:
                pass

def import_png_bytes_to_gimp(image, image_bytes: bytes, layer_name: str = "Pollinations AI Result", create_new_image: bool = False):
    """Loads generated PNG image bytes and inserts it into GIMP as a new layer or new image."""
    temp_file = os.path.join(tempfile.gettempdir(), f"gimp_polli_output_{os.getpid()}.png")
    try:
        with open(temp_file, "wb") as f:
            f.write(image_bytes)

        gio_file = Gio.File.new_for_path(temp_file)

        if create_new_image or image is None:
            new_img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, gio_file)
            display = Gimp.Display.new(new_img)
            Gimp.displays_flush()
            return new_img
        else:
            new_layer = Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, image, gio_file)
            new_layer.set_name(layer_name)
            image.insert_layer(new_layer, None, 0)
            Gimp.displays_flush()
            return new_layer
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception:
                pass
