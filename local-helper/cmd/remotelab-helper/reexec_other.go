//go:build !darwin && !linux

package main

func reexecHelperBinary(_ string) error {
	return nil
}
