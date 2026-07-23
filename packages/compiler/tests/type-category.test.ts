import { describe, expect, it } from "vitest";
import {
  isCompileTimeOnlyCategory,
  isReferenceCategory,
  isValueCategory,
  typeCategory,
  typeKind,
  type ClassifiableType,
} from "../src/types/category.js";

describe("type category classification", () => {
  describe("typeKind", () => {
    it("classifies primitives, string, null, and void", () => {
      expect(typeKind("i32")).toBe("primitive");
      expect(typeKind("i64")).toBe("primitive");
      expect(typeKind("f32")).toBe("primitive");
      expect(typeKind("f64")).toBe("primitive");
      expect(typeKind("bool")).toBe("primitive");
      expect(typeKind("char")).toBe("primitive");
      expect(typeKind("string")).toBe("string");
      expect(typeKind("null")).toBe("null");
      expect(typeKind("void")).toBe("void");
    });

    it("classifies compound kinds by discriminant", () => {
      expect(typeKind({ kind: "struct", name: "Point" })).toBe("struct");
      expect(typeKind({ kind: "enum", name: "Color" })).toBe("enum");
      expect(typeKind({ kind: "class", name: "Person" })).toBe("class");
      expect(typeKind({ kind: "array", element: "i32" })).toBe("array");
      expect(typeKind({ kind: "tuple", elements: ["i32", "bool"] })).toBe("tuple");
      expect(typeKind({ kind: "map", valueType: "i32" })).toBe("map");
      expect(typeKind({ kind: "function", isAsync: false, params: ["i32"], returnType: "void" })).toBe("function");
      expect(typeKind({ kind: "interface", name: "Printable" })).toBe("interface");
      expect(
        typeKind({
          kind: "object",
          name: "__obj",
          fields: [],
          indexType: null,
        }),
      ).toBe("object");
      expect(typeKind({ kind: "literal", value: 1, literalKind: "number" })).toBe("literal");
      expect(typeKind({ kind: "union", arms: ["i32", "null"] })).toBe("union");
      expect(typeKind({ kind: "intersection", arms: ["i32", "bool"] })).toBe("intersection");
      expect(
        typeKind({
          kind: "typeParam",
          name: "T",
          constraintName: null,
          constraintKind: null,
        }),
      ).toBe("typeParam");
    });
  });

  describe("typeCategory — table types", () => {
    it("classifies value primitives", () => {
      for (const t of ["i32", "i64", "f32", "f64", "bool", "char"] as const) {
        expect(typeCategory(t)).toBe("value");
        expect(isValueCategory(t)).toBe(true);
      }
    });

    it("classifies enums, structs, tuples, and objects as value", () => {
      expect(typeCategory({ kind: "enum", name: "Color" })).toBe("value");
      expect(typeCategory({ kind: "struct", name: "Point" })).toBe("value");
      expect(typeCategory({ kind: "tuple", elements: ["i32", "bool"] })).toBe("value");
      expect(
        typeCategory({
          kind: "object",
          name: "__obj",
          fields: [{ name: "x", type: "i32", readonly: false }],
          indexType: null,
        }),
      ).toBe("value");
    });

    it("classifies reference types", () => {
      expect(typeCategory("string")).toBe("reference");
      expect(typeCategory("null")).toBe("reference");
      expect(typeCategory({ kind: "class", name: "Person" })).toBe("reference");
      expect(typeCategory({ kind: "array", element: "i32" })).toBe("reference");
      expect(typeCategory({ kind: "map", valueType: "i32" })).toBe("reference");
      expect(typeCategory({ kind: "function", isAsync: false, params: [], returnType: "i32" })).toBe("reference");
      expect(isReferenceCategory("string")).toBe(true);
    });

    it("classifies interfaces, type params, and void as compile-time only", () => {
      expect(typeCategory({ kind: "interface", name: "Printable" })).toBe("compileTimeOnly");
      expect(
        typeCategory({
          kind: "typeParam",
          name: "T",
          constraintName: null,
          constraintKind: null,
        }),
      ).toBe("compileTimeOnly");
      expect(typeCategory("void")).toBe("compileTimeOnly");
      expect(isCompileTimeOnlyCategory("void")).toBe(true);
    });
  });

  describe("typeCategory — literals", () => {
    it("classifies number literals as value and string literals as reference", () => {
      expect(typeCategory({ kind: "literal", value: 42, literalKind: "number" })).toBe("value");
      expect(typeCategory({ kind: "literal", value: "hi", literalKind: "string" })).toBe(
        "reference",
      );
    });
  });

  describe("typeCategory — unions and intersections", () => {
    it("treats nullable types as reference when null is present", () => {
      const personNull: ClassifiableType = {
        kind: "union",
        arms: [{ kind: "class", name: "Person" }, "null"],
      };
      const i32Null: ClassifiableType = { kind: "union", arms: ["i32", "null"] };
      expect(typeCategory(personNull)).toBe("reference");
      expect(typeCategory(i32Null)).toBe("reference");
    });

    it("classifies value-only unions as value", () => {
      expect(typeCategory({ kind: "union", arms: ["i32", "bool"] })).toBe("value");
      expect(
        typeCategory({
          kind: "union",
          arms: [
            { kind: "struct", name: "Point" },
            { kind: "enum", name: "Color" },
          ],
        }),
      ).toBe("value");
    });

    it("prefers reference over compile-time-only over value", () => {
      expect(
        typeCategory({
          kind: "union",
          arms: [{ kind: "interface", name: "Printable" }, "i32"],
        }),
      ).toBe("compileTimeOnly");

      expect(
        typeCategory({
          kind: "union",
          arms: [{ kind: "interface", name: "Printable" }, { kind: "class", name: "Person" }],
        }),
      ).toBe("reference");

      expect(
        typeCategory({
          kind: "intersection",
          arms: [{ kind: "interface", name: "A" }, { kind: "interface", name: "B" }],
        }),
      ).toBe("compileTimeOnly");

      expect(
        typeCategory({
          kind: "intersection",
          arms: [{ kind: "struct", name: "Point" }, { kind: "interface", name: "Printable" }],
        }),
      ).toBe("compileTimeOnly");

      expect(
        typeCategory({
          kind: "intersection",
          arms: [{ kind: "struct", name: "Point" }, { kind: "class", name: "Person" }],
        }),
      ).toBe("reference");
    });
  });
});
