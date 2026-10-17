package quic_test

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/protocol/quic"
)

func shortInitialPacket(version uint32, firstByte byte) []byte {
	packet := binary.BigEndian.AppendUint32([]byte{firstByte}, version)
	// Empty connection IDs and token, then four bytes of declared payload:
	// enough for the packet number, but not the header-protection sample.
	return append(packet, 0, 0, 0, 4, 0, 0, 0, 0)
}

func TestSniffQUICShortHeaderProtectionSample(t *testing.T) {
	for _, test := range []struct {
		name      string
		version   uint32
		firstByte byte
	}{
		{"draft29", 0xff00001d, 0xc0},
		{"v1", 0x00000001, 0xc0},
		{"v2", 0x6b3343cf, 0xd0},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := quic.SniffQUIC(shortInitialPacket(test.version, test.firstByte)); err == nil {
				t.Fatal("accepted an Initial without a complete header-protection sample")
			}
		})
	}
}

func TestSniffQUICv2IncompleteAndTruncated(t *testing.T) {
	packets, err := hex.DecodeString(quicV2InitialPackets)
	if err != nil {
		t.Fatal(err)
	}
	// The upstream capture splits its ClientHello across 1280-byte packets.
	if _, err := quic.SniffQUIC(bytes.Clone(packets[:1280])); !errors.Is(err, protocol.ErrProtoNeedMoreData) {
		t.Fatalf("first packet: got %v, want more crypto data", err)
	}
	// Exercise every truncation boundary, including inside encrypted payloads
	// and between coalesced packets. None may panic on untrusted UDP input.
	for end := 0; end < len(packets); end++ {
		quic.SniffQUIC(bytes.Clone(packets[:end]))
	}

	unknownVersion := bytes.Clone(packets)
	binary.BigEndian.PutUint32(unknownVersion[1:5], 0x12345678)
	if _, err := quic.SniffQUIC(unknownVersion); err == nil {
		t.Fatal("accepted an unsupported QUIC version")
	}
}

func FuzzSniffQUIC(f *testing.F) {
	packets, err := hex.DecodeString(quicV2InitialPackets)
	if err != nil {
		f.Fatal(err)
	}
	f.Add([]byte{})
	f.Add(packets)
	f.Add(packets[:1280])
	f.Add(shortInitialPacket(0xff00001d, 0xc0))
	f.Add(shortInitialPacket(0x00000001, 0xc0))
	f.Add(shortInitialPacket(0x6b3343cf, 0xd0))
	f.Fuzz(func(t *testing.T, packet []byte) {
		if len(packet) > 32767 { // Match the dispatcher's bounded sniff buffer.
			t.Skip()
		}
		// SniffQUIC decrypts in place; keep the fuzzer's input unchanged.
		header, err := quic.SniffQUIC(bytes.Clone(packet))
		if err == nil && (header == nil || header.Protocol() != "quic" || header.Domain() == "") {
			t.Fatalf("successful sniff without a QUIC domain: %+v", header)
		}
	})
}
