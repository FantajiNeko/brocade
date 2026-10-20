package command

import (
	"encoding/hex"
	"strconv"
	"strings"

	featurestats "github.com/xtls/xray-core/features/stats"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *statsServer) acknowledgeDetail(request *QueryStatsRequest) (*QueryStatsResponse, error) {
	invalid := status.Error(codes.InvalidArgument, "invalid detail checkpoint")
	parts := strings.Split(request.Pattern, ">>>")
	if request.Reset_ || len(parts) != 4 || len(parts[2]) != 32 || len(parts[3]) > 256*62 {
		return nil, invalid
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return nil, invalid
	}
	rows := strings.Split(parts[3], ",")
	if len(rows) > 256 {
		return nil, invalid
	}
	checkpoints := make([]featurestats.DetailCheckpoint, 0, len(rows))
	for _, row := range rows {
		values := strings.Split(row, ":")
		if len(values) != 3 {
			return nil, invalid
		}
		id, e1 := strconv.ParseUint(values[0], 10, 63)
		up, e2 := strconv.ParseInt(values[1], 10, 64)
		down, e3 := strconv.ParseInt(values[2], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil || id == 0 || up < 0 || down < 0 {
			return nil, invalid
		}
		checkpoints = append(checkpoints, featurestats.DetailCheckpoint{ID: id, Up: up, Down: down})
	}
	if provider, ok := s.stats.(interface {
		AcknowledgeDetail(string, string, []featurestats.DetailCheckpoint)
	}); ok {
		provider.AcknowledgeDetail(parts[0]+">>>", parts[2], checkpoints)
	}
	return &QueryStatsResponse{}, nil
}
