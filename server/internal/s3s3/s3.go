// Package s3s3 封装 S3 兼容存储（生产 S3 / 开发 MinIO）：预签名与 HEAD。
package s3s3

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type Client struct {
	s3c    *s3.Client
	presig *s3.PresignClient
	bucket string
}

func New(endpoint, region, accessKey, secretKey, bucket string, usePathStyle bool) *Client {
	s3c := s3.New(s3.Options{
		Region:       region,
		Credentials:  credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
		BaseEndpoint: aws.String(endpoint),
		UsePathStyle: usePathStyle,
	})
	return &Client{s3c: s3c, presig: s3.NewPresignClient(s3c), bucket: bucket}
}

func (c *Client) PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := c.presig.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(c.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (c *Client) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := c.presig.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket), Key: aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// Head 返回对象大小；不存在（或出错）返回 ok=false。
func (c *Client) Head(ctx context.Context, key string) (size int64, ok bool) {
	out, err := c.s3c.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket), Key: aws.String(key),
	})
	if err != nil {
		return 0, false
	}
	if out.ContentLength != nil {
		return *out.ContentLength, true
	}
	return 0, true
}

// EnsureBucket：不存在则创建（幂等）。
func (c *Client) EnsureBucket(ctx context.Context) error {
	_, err := c.s3c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(c.bucket)})
	if err == nil {
		return nil
	}
	var bae *types.BucketAlreadyOwnedByYou
	if errors.As(err, &bae) {
		return nil
	}
	if strings.Contains(err.Error(), "BucketAlreadyExists") || strings.Contains(err.Error(), "already exists") {
		return nil // 已由本账号持有或已存在
	}
	return err
}

// Delete 批量删除对象（保留策略用）。S3 批量删除对不存在的 key 也算成功（幂等）。
func (c *Client) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	objs := make([]types.ObjectIdentifier, 0, len(keys))
	for _, k := range keys {
		objs = append(objs, types.ObjectIdentifier{Key: aws.String(k)})
	}
	out, err := c.s3c.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(c.bucket),
		Delete: &types.Delete{Objects: objs},
	})
	if err != nil {
		return err
	}
	if len(out.Errors) > 0 {
		first := out.Errors[0]
		key, msg := "", ""
		if first.Key != nil {
			key = *first.Key
		}
		if first.Message != nil {
			msg = *first.Message
		}
		return fmt.Errorf("s3 delete %s: %s", key, msg)
	}
	return nil
}

func Keys(userID, envID, snapID string) (manifest, blob string) {
	base := "u/" + userID + "/envs/" + envID + "/snapshots/" + snapID + "/"
	return base + "manifest.json", base + "blob.enc"
}
