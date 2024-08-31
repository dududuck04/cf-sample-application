'use strict';

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import querystring from 'querystring';
import { performance } from 'perf_hooks';

const BUCKET = "cloudfront-resizing-bucket";
const s3 = new S3Client({ region: 'us-east-1' });

function makeResponse(status, statusDescription, bodyContent, contentType) {
    return {
        status,
        statusDescription,
        headers: {
            'content-type': [{
                key: 'Content-Type',
                value: contentType || 'application/json'
            }]
        },
        body: bodyContent,
        bodyEncoding: contentType ? 'base64' : undefined,
    };
}

// 스트림을 버퍼로 변환하는 도우미 함수
const streamToBuffer = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
});

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    try {
        const { request, response } = event.Records[0].cf;
        const uri = request.uri;
        const params = querystring.parse(request.querystring);

        // 헤더 값 추출
        const transformType = request.headers['x-custom-transform'] && request.headers['x-custom-transform'][0].value;
        const option = request.headers['x-custom-option'] && request.headers['x-custom-option'][0].value;

        console.log('Extracted headers:', { transformType, option });

        let match, imageName, extension, originalKey, width, height, left, top;

        // URI에서 이미지 파일명과 변환 정보를 추출합니다.
        if (transformType === 'crop' || transformType === 'crop+resize') {
            match = uri.match(/\/(.+)\.(jpg|jpeg|png)\/(\d+)x(\d+)\+(\d+)\+(\d+)(\/(\d+)x(\d+))?/);
            if (!match) {
                console.log('Invalid URI format for crop');
                return makeResponse('400', 'Bad Request', 'Invalid URI format for crop');
            }

            const [fullMatch, imgName, ext, cropWidth, cropHeight, cropX, cropY, , resizeWidth, resizeHeight] = match;
            imageName = imgName;
            extension = ext;
            originalKey = `${imageName}.${extension}`;

            width = parseInt(cropWidth, 10);
            height = parseInt(cropHeight, 10);
            left = parseInt(cropX, 10);
            top = parseInt(cropY, 10);

            if (isNaN(width) || isNaN(height) || isNaN(left) || isNaN(top)) {
                throw new Error(`Invalid crop parameters: ${JSON.stringify({ width, height, left, top })}`);
            }

            console.log('Extracted crop parameters:', { width, height, left, top });

            params.cropWidth = width;
            params.cropHeight = height;
            params.cropX = left;
            params.cropY = top;

            if (resizeWidth && resizeHeight) {
                params.resizeWidth = parseInt(resizeWidth, 10);
                params.resizeHeight = parseInt(resizeHeight, 10);
                console.log('Extracted resize parameters:', { resizeWidth: params.resizeWidth, resizeHeight: params.resizeHeight });
            }

        } else if (transformType === 'resize') {
            match = uri.match(/\/(.+)\.(jpg|jpeg|png)\/(\d+)x(\d+)/);
            if (!match) {
                console.log('Invalid URI format for resize');
                return makeResponse('400', 'Bad Request', 'Invalid URI format for resize');
            }

            const [fullMatch, imgName, ext, resizeWidth, resizeHeight] = match;
            imageName = imgName;
            extension = ext;
            originalKey = `${imageName}.${extension}`;

            width = parseInt(resizeWidth, 10);
            height = parseInt(resizeHeight, 10);

            if (isNaN(width) || isNaN(height)) {
                throw new Error(`Invalid resize parameters: ${JSON.stringify({ width, height })}`);
            }

            console.log('Extracted resize parameters:', { width, height });

            params.resizeWidth = width;
            params.resizeHeight = height;
        } else {
            console.log('Unknown transform type');
            return makeResponse('400', 'Bad Request', 'Unknown transform type');
        }

        console.log('Extracted image details:', { imageName, extension, originalKey });

        // S3에서 원본 이미지를 가져옵니다.
        try {
            const originalObjectCommand = new GetObjectCommand({ Bucket: BUCKET, Key: originalKey });
            const data = await s3.send(originalObjectCommand);
            if (!data || !data.Body) {
                console.log('Original image not found');
                return makeResponse('404', 'Not Found', 'Not Found: Original image not found');
            }

            console.log('Got original image from S3');

            const originalContentType = data.ContentType || 'image/jpeg';
            console.log('Original content type:', originalContentType);

            const originalImageBuffer = await streamToBuffer(data.Body);

            // Sharp 인스턴스 생성
            let sharpInstance = sharp(originalImageBuffer);

            // 원본 이미지의 크기 가져오기
            // const metadata = await sharpInstance.metadata();
            // console.log('Original image metadata:', metadata);

            // 이미지 크롭 적용
            if (transformType === 'crop' || transformType === 'crop+resize') {
                const { cropWidth, cropHeight, cropX, cropY } = params;

                // 크롭 영역 검증
                // if (cropX + cropWidth > metadata.width || cropY + cropHeight > metadata.height) {
                //     throw new Error(`Invalid crop area: ${JSON.stringify({ cropWidth, cropHeight, cropX, cropY })}`);
                // }

                console.log('Applying crop with parameters:', { cropWidth, cropHeight, cropX, cropY });

                const cropStartTime = performance.now();
                sharpInstance = sharpInstance.extract({
                    width: cropWidth,
                    height: cropHeight,
                    left: cropX,
                    top: cropY
                });
                const cropEndTime = performance.now();
                console.log(`Crop operation took ${cropEndTime - cropStartTime} milliseconds`);
            }

            // 이미지 리사이즈 적용
            if (transformType === 'resize' || (transformType === 'crop+resize' && params.resizeWidth && params.resizeHeight)) {
                console.log('Applying resize with parameters:', { width: params.resizeWidth, height: params.resizeHeight });

                const resizeStartTime = performance.now();
                sharpInstance = sharpInstance.resize(params.resizeWidth, params.resizeHeight);
                const resizeEndTime = performance.now();
                console.log(`Resize operation took ${resizeEndTime - resizeStartTime} milliseconds`);
            }

            // 최적화 설정 적용
            if (option === 'optimize') {
                console.log('Applying optimization for extension:', extension);

                const optimizeStartTime = performance.now();
                if (extension === 'jpg' || extension === 'jpeg') {
                    sharpInstance = sharpInstance.jpeg({ quality: 80, progressive: true, optimizeCoding: true });
                } else if (extension === 'png') {
                    sharpInstance = sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true });
                }
                const optimizeEndTime = performance.now();
                console.log(`Optimize operation took ${optimizeEndTime - optimizeStartTime} milliseconds`);
            }

            const transformedImage = await sharpInstance.toBuffer();

            console.log('Image transformation successful');

            response.body = transformedImage.toString('base64');
            response.bodyEncoding = 'base64';
            response.headers['content-type'] = [{ key: 'Content-Type', value: originalContentType }];
            response.status = '200';
            response.statusDescription = 'OK';

            return response;

        } catch (err) {
            console.error('Error processing image:', err);
            return makeResponse('500', 'Internal Server Error', `Internal Server Error: ${err.message}`);
        }

    } catch (err) {
        console.error('Error processing image:', err);
        return makeResponse('500', 'Internal Server Error', `Internal Server Error: ${err.message}`);
    }
};
