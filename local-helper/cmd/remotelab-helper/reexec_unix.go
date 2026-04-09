//go:build darwin || linux

package main

import (
	"os"
	"syscall"
)

func reexecHelperBinary(path string) error {
	return syscall.Exec(path, []string{path, "serve"}, os.Environ())
}
