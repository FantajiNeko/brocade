package main

import (
	"bytes"
	"fmt"
	"io"
	"testing"

	"github.com/xtls/xray-core/proxy/hysteria"
)

type messageReader struct{ messages [][]byte }

func (r *messageReader) Read(b []byte) (int, error) {
	if len(r.messages) == 0 {
		return 0, io.EOF
	}
	m := r.messages[0]
	r.messages = r.messages[1:]
	return copy(b, m), nil
}

// UDPReader reuses a single read buffer. A defragmenter must not keep aliases
// into that buffer after the next Read overwrites it.
func TestHysteriaDefragWithReusedReadBuffer(t *testing.T) {
	for _, maxSize := range []int{1400, 1150} {
		for _, ownData := range []bool{false, true} {
			t.Run(fmt.Sprintf("mtu-%d/owned-data-%t", maxSize, ownData), func(t *testing.T) {
				payload := make([]byte, 1200)
				for i := range payload {
					payload[i] = byte(i % 251)
				}
				original := &hysteria.UDPMessage{PacketID: 17, FragCount: 1, Addr: "127.0.0.1:443", Data: payload}
				fragments := hysteria.FragUDPMessage(original, maxSize)
				r := &messageReader{}
				for i := range fragments {
					b := make([]byte, fragments[i].Size())
					n := fragments[i].Serialize(b)
					r.messages = append(r.messages, b[:n])
				}
				// UDPReader's fields are private. Exercise the public parser/defrag
				// pair with the same shared-buffer lifetime instead.
				buffer := make([]byte, 65535)
				df := &hysteria.Defragger{}
				for range fragments {
					n, e := r.Read(buffer)
					if e != nil {
						t.Fatal(e)
					}
					data := buffer[:n]
					// Positive control: only the lifetime of the input differs.
					if ownData {
						data = bytes.Clone(data)
					}
					message, e := hysteria.ParseUDPMessage(data)
					if e != nil {
						t.Fatal(e)
					}
					if got := df.Feed(message); got != nil {
						if !bytes.Equal(got.Data, payload) {
							t.Fatalf("%d fragments: reconstructed payload differs; first 16 bytes got=%x want=%x", len(fragments), got.Data[:16], payload[:16])
						}
						return
					}
				}
				t.Fatal("no completed datagram")
			})
		}
	}
}
