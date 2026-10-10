package auth

import (
	"strings"
	"testing"
)

func TestVerifierRoundTrip(t *testing.T) {
	encoded, err := HashAuthKey("auth-key-example-123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$") {
		t.Fatalf("unexpected prefix: %s", encoded[:30])
	}
	ok, err := VerifyAuthKey(encoded, "auth-key-example-123")
	if err != nil || !ok {
		t.Fatalf("verify correct key = %v, %v", ok, err)
	}
	ok, err = VerifyAuthKey(encoded, "wrong")
	if err != nil || ok {
		t.Fatalf("verify wrong key = %v, %v", ok, err)
	}
	// 相同输入每次盐不同（防彩虹表）
	other, _ := HashAuthKey("auth-key-example-123")
	if other == encoded {
		t.Fatal("salt should be random per hash")
	}
}
