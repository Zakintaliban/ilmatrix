import type { Context } from "hono";
import { materialService } from "../services/materialService.js";
import { isValidMaterialId } from "../utils/security.js";

export class MaterialController {
  /**
   * Get material information and file list
   */
  async getMaterial(c: Context) {
    try {
      const materialId = c.req.param("id");

      if (!isValidMaterialId(materialId)) {
        return c.json({ error: "Invalid material ID" }, 400);
      }

      const materialInfo = await materialService.getMaterialInfo(materialId);
      return c.json(materialInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("not found") || message.includes("ENOENT")) {
        return c.json({ error: "Material not found" }, 404);
      }

      return c.json({ error: message }, 400);
    }
  }

  /**
   * Remove specific file from material
   */
  async removeFileFromMaterial(c: Context) {
    try {
      const materialId = c.req.param("id");

      if (!isValidMaterialId(materialId)) {
        return c.json({ error: "Invalid material ID" }, 400);
      }

      const body = await c.req.json();
      const fileName = body.name;

      if (!fileName || typeof fileName !== "string") {
        return c.json({ error: "File name is required" }, 400);
      }

      const result = await materialService.removeFileFromMaterial(
        materialId,
        fileName
      );

      return c.json({
        ...result,
        removed: fileName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }

      return c.json({ error: message }, 400);
    }
  }

  /**
   * Delete entire material
   */
  async deleteMaterial(c: Context) {
    try {
      const materialId = c.req.param("id");

      if (!isValidMaterialId(materialId)) {
        return c.json({ error: "Invalid material ID" }, 400);
      }

      await materialService.deleteMaterial(materialId);

      return c.json({
        success: true,
        materialId,
        message: "Material deleted successfully",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  }
}

export const materialController = new MaterialController();
