package runadmission_test

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestRunFoundationDoesNotImportExecutionImplementations(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test path")
	}
	internal := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	directories := []string{
		filepath.Join(internal, "openfang"),
		filepath.Join(internal, "handlers", "agents"),
		filepath.Join(internal, "handlers", "runs"),
		filepath.Join(internal, "handlers", "events"),
		filepath.Join(internal, "repository", "runs"),
		filepath.Join(internal, "service", "runadmission"),
	}
	for _, directory := range directories {
		directory := directory
		err := filepath.WalkDir(directory, func(
			path string,
			entry fs.DirEntry,
			walkErr error,
		) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || filepath.Ext(path) != ".go" {
				return nil
			}
			file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, imported := range file.Imports {
				value, err := strconv.Unquote(imported.Path.Value)
				if err != nil {
					return err
				}
				lower := strings.ToLower(value)
				if strings.Contains(lower, "multica") ||
					strings.Contains(lower, "/daemon") ||
					strings.Contains(lower, "/provider") ||
					strings.Contains(lower, "/executor") {
					t.Errorf("%s imports forbidden execution implementation %q", path, value)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", directory, err)
		}
	}
}
