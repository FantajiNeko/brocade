package encoding

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func TestMarshalCommandKeepsUnsupportedCommandSemantics(t *testing.T) {
	for _, command := range []any{nil, struct{}{}} {
		var output bytes.Buffer
		if err := MarshalCommand(command, &output); !errors.Is(err, ErrUnknownCommand) {
			t.Fatalf("MarshalCommand(%T) error = %v, want ErrUnknownCommand", command, err)
		}
		if output.Len() != 0 {
			t.Fatalf("MarshalCommand(%T) wrote %d bytes for an unsupported command", command, output.Len())
		}
	}
}

func TestUnmarshalCommandValidatesEnvelopeBeforeRejectingCommand(t *testing.T) {
	if _, err := UnmarshalCommand(1, make([]byte, 4)); !errors.Is(err, ErrInsufficientLength) {
		t.Fatalf("short envelope error = %v, want ErrInsufficientLength", err)
	}

	invalid := append(make([]byte, 4), byte(1))
	if _, err := UnmarshalCommand(1, invalid); !errors.Is(err, ErrInvalidAuth) {
		t.Fatalf("invalid auth error = %v, want ErrInvalidAuth", err)
	}

	payload := []byte("unsupported-response-command")
	valid := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(valid, Authenticate(payload))
	copy(valid[4:], payload)
	if _, err := UnmarshalCommand(1, valid); !errors.Is(err, ErrUnknownCommand) {
		t.Fatalf("unknown command error = %v, want ErrUnknownCommand", err)
	}
}
