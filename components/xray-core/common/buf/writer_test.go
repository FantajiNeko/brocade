package buf_test

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"io"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/xtls/xray-core/common"
	. "github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/transport/pipe"
)

func TestWriter(t *testing.T) {
	lb := New()
	common.Must2(lb.ReadFrom(rand.Reader))

	expectedBytes := append([]byte(nil), lb.Bytes()...)

	writeBuffer := bytes.NewBuffer(make([]byte, 0, 1024*1024))

	writer := NewBufferedWriter(NewWriter(writeBuffer))
	writer.SetBuffered(false)
	common.Must(writer.WriteMultiBuffer(MultiBuffer{lb}))
	common.Must(writer.Flush())

	if r := cmp.Diff(expectedBytes, writeBuffer.Bytes()); r != "" {
		t.Error(r)
	}
}

func TestBufferedWriterCrossCapacity(t *testing.T) {
	for _, size := range []int{32, 2*int(Size) + 32} {
		var output bytes.Buffer
		writer := NewBufferedWriter(NewWriter(&output))
		first := bytes.Repeat([]byte{'a'}, int(Size)-8)
		second := bytes.Repeat([]byte{'b'}, size)
		for _, payload := range [][]byte{first, second} {
			if n, err := writer.Write(payload); n != len(payload) || err != nil {
				t.Fatalf("write %d bytes: got %d, %v", len(payload), n, err)
			}
		}
		common.Must(writer.Close())
		if !bytes.Equal(output.Bytes(), append(first, second...)) {
			t.Fatal("cross-capacity write lost or reordered bytes")
		}
	}
}

func TestBytesWriterReadFrom(t *testing.T) {
	const size = 50000
	pReader, pWriter := pipe.New(pipe.WithSizeLimit(size))
	reader := bufio.NewReader(io.LimitReader(rand.Reader, size))
	writer := NewBufferedWriter(pWriter)
	writer.SetBuffered(false)
	nBytes, err := reader.WriteTo(writer)
	if nBytes != size {
		t.Fatal("unexpected size of bytes written: ", nBytes)
	}
	if err != nil {
		t.Fatal("expect success, but actually error: ", err.Error())
	}

	mb, err := pReader.ReadMultiBuffer()
	common.Must(err)
	if mb.Len() != size {
		t.Fatal("unexpected size read: ", mb.Len())
	}
}

func TestDiscardBytes(t *testing.T) {
	b := New()
	common.Must2(b.ReadFullFrom(rand.Reader, Size))

	nBytes, err := io.Copy(DiscardBytes, b)
	common.Must(err)
	if nBytes != Size {
		t.Error("copy size: ", nBytes)
	}
}

func TestDiscardBytesMultiBuffer(t *testing.T) {
	const size = 10240*1024 + 1
	buffer := bytes.NewBuffer(make([]byte, 0, size))
	common.Must2(buffer.ReadFrom(io.LimitReader(rand.Reader, size)))

	r := NewReader(buffer)
	nBytes, err := io.Copy(DiscardBytes, &BufferedReader{Reader: r})
	common.Must(err)
	if nBytes != size {
		t.Error("copy size: ", nBytes)
	}
}

func TestWriterInterface(t *testing.T) {
	{
		var writer interface{} = (*BufferToBytesWriter)(nil)
		switch writer.(type) {
		case Writer, io.Writer, io.ReaderFrom:
		default:
			t.Error("BufferToBytesWriter is not Writer, io.Writer or io.ReaderFrom")
		}
	}

	{
		var writer interface{} = (*BufferedWriter)(nil)
		switch writer.(type) {
		case Writer, io.Writer, io.ReaderFrom, io.ByteWriter:
		default:
			t.Error("BufferedWriter is not Writer, io.Writer, io.ReaderFrom or io.ByteWriter")
		}
	}
}
