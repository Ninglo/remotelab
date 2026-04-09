package main

import "testing"

func TestDefaultConfigAllowsAnyStageExtension(t *testing.T) {
	cfg := defaultConfig()
	for _, ext := range []string{".md", ".markdown", ".json", ".custom", ".rvt", ".bin"} {
		if !extensionAllowed(cfg, ext) {
			t.Fatalf("expected default config to allow %s", ext)
		}
	}
}

func TestMergeAllowedExtensionsDeduplicatesExistingValues(t *testing.T) {
	merged := mergeAllowedExtensions(
		nil,
		[]string{".txt", ".custom", ".MD"},
	)
	want := []string{".txt", ".custom", ".md"}
	if len(merged) != len(want) {
		t.Fatalf("expected %d merged extensions, got %d (%v)", len(want), len(merged), merged)
	}
	for index, value := range want {
		if merged[index] != value {
			t.Fatalf("expected merged[%d] = %s, got %s", index, value, merged[index])
		}
	}
}

func TestApplyInternalReadAllDefaultsUpgradesLegacyRootsAndStageFilter(t *testing.T) {
	legacy := legacyDefaultConfigSignature()
	cfg := applyInternalReadAllDefaults(Config{
		AllowedRoots: legacy.roots,
		Stage: StageConfig{
			AllowedExtensions: append([]string{}, legacy.allowedExtensions...),
		},
	})

	if len(cfg.AllowedRoots) == 0 {
		t.Fatal("expected upgraded config to expose at least one root")
	}
	if sameStringMap(cfg.AllowedRoots, legacy.roots) {
		t.Fatalf("expected legacy roots to be upgraded, got %v", cfg.AllowedRoots)
	}
	if len(cfg.Stage.AllowedExtensions) != 0 {
		t.Fatalf("expected legacy stage extension allowlist to be removed, got %v", cfg.Stage.AllowedExtensions)
	}
	if !extensionAllowed(cfg, ".bin") {
		t.Fatal("expected unrestricted stage config to allow arbitrary extensions after upgrade")
	}
}
