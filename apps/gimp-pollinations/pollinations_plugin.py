#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GIMP 3.0+ Plug-in: Pollinations AI
Brings Pollinations AI image generation and editing directly inside GIMP 3.
Supports BYOP device authorization, live model catalog, text-to-image, and image editing.
"""

import sys
import gi

gi.require_version("Gimp", "3.0")
gi.require_version("GimpUi", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gimp, GimpUi, Gtk, GLib, Gio

from pollinations_api import PollinationsAPI, PollinationsAPIError
from pollinations_auth import AuthManager
from pollinations_ui import PollinationsDialog
from pollinations_gimp_utils import export_drawable_to_png_bytes, import_png_bytes_to_gimp

PROC_NAME = "python-fu-pollinations-ai"

def _(msg):
    return GLib.dgettext(None, msg)

class PollinationsPlugin(Gimp.PlugIn):

    def do_set_i18n(self, procname):
        return True, "gimp30-python", None

    def do_query_procedures(self):
        return [PROC_NAME]

    def do_create_procedure(self, name):
        if name != PROC_NAME:
            return None

        procedure = Gimp.ImageProcedure.new(
            self,
            name,
            Gimp.PDBProcType.PLUGIN,
            self.run,
            None
        )

        procedure.set_image_types("*")
        procedure.set_sensitivity_mask(
            Gimp.ProcedureSensitivityMask.DRAWABLE |
            Gimp.ProcedureSensitivityMask.DRAWABLES |
            Gimp.ProcedureSensitivityMask.NO_DRAWABLES |
            Gimp.ProcedureSensitivityMask.NO_IMAGE
        )

        procedure.set_documentation(
            _("Pollinations AI Generator & Editor"),
            _("Generate and edit images inside GIMP using Pollinations AI with BYOP device authorization."),
            name
        )

        procedure.set_menu_label(_("Pollinations AI..."))
        procedure.set_attribution("Pollinations Community", "Pollinations.ai", "2026")
        procedure.add_menu_path("<Image>/Filters/Render/Pollinations AI")

        return procedure

    def run(self, procedure, run_mode, image, drawables, config, data):
        auth_manager = AuthManager()
        token = auth_manager.get_token()
        api_client = PollinationsAPI(token=token)

        prompt = ""
        model_id = "zimage"
        width = 1024
        height = 1024
        target = "new_layer"
        selected_model = None

        if run_mode == Gimp.RunMode.INTERACTIVE:
            GimpUi.init("pollinations-ai")
            dialog = PollinationsDialog(None, api_client, auth_manager)
            response = dialog.run()

            if response != Gtk.ResponseType.OK:
                dialog.destroy()
                return procedure.new_return_values(Gimp.PDBStatusType.CANCEL, None)

            opts = dialog.get_user_options()
            dialog.destroy()

            prompt = opts.get("prompt", "").strip()
            model_id = opts.get("model", "zimage")
            width = opts.get("width", 1024)
            height = opts.get("height", 1024)
            target = opts.get("target", "new_layer")
            selected_model = opts.get("selected_model")
        else:
            prompt = "a serene mountain landscape at sunset"

        if not prompt:
            error = GLib.Error.new_literal(Gimp.PlugIn.error_quark(), "Prompt cannot be empty.", 0)
            return procedure.new_return_values(Gimp.PDBStatusType.EXECUTION_ERROR, error)

        try:
            Gimp.progress_init(_("Generating image with Pollinations AI..."))

            drawable = drawables[0] if drawables and len(drawables) > 0 else None
            is_image_edit = False

            if selected_model and selected_model.get("supports_image_input") and image and drawable:
                is_image_edit = True

            if is_image_edit:
                Gimp.progress_update(0.2)
                input_png_bytes = export_drawable_to_png_bytes(image, drawable)
                Gimp.progress_update(0.4)
                output_bytes = api_client.edit_image(
                    prompt=prompt,
                    image_bytes=input_png_bytes,
                    model=model_id,
                    width=width,
                    height=height
                )
            else:
                Gimp.progress_update(0.3)
                output_bytes = api_client.generate_image(
                    prompt=prompt,
                    model=model_id,
                    width=width,
                    height=height
                )

            Gimp.progress_update(0.8)
            create_new_img = (target == "new_image" or image is None)
            import_png_bytes_to_gimp(
                image=image,
                image_bytes=output_bytes,
                layer_name=f"Pollinations ({model_id})",
                create_new_image=create_new_img
            )
            Gimp.progress_update(1.0)
            Gimp.progress_end()

            return procedure.new_return_values(Gimp.PDBStatusType.SUCCESS, None)

        except PollinationsAPIError as e:
            Gimp.progress_end()
            error = GLib.Error.new_literal(Gimp.PlugIn.error_quark(), f"Pollinations API Error: {e.message}", 0)
            return procedure.new_return_values(Gimp.PDBStatusType.EXECUTION_ERROR, error)
        except Exception as e:
            Gimp.progress_end()
            error = GLib.Error.new_literal(Gimp.PlugIn.error_quark(), f"Unexpected Error: {str(e)}", 0)
            return procedure.new_return_values(Gimp.PDBStatusType.EXECUTION_ERROR, error)

if __name__ == "__main__":
    Gimp.main(PollinationsPlugin.__gtype__, sys.argv)
