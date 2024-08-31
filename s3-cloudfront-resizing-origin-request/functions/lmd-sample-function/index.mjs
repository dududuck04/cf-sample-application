'use strict';

export const handler = async (event) => {
    console.log('Received origin request event:', JSON.stringify(event, null, 2));

    try {
        const { request } = event.Records[0].cf;

        console.log('Request headers in origin request:', JSON.stringify(request.headers, null, 2));

        // 요청을 그대로 전달합니다.
        return request;
    } catch (err) {
        console.log('Error processing origin request:', err);
        return {
            status: '500',
            statusDescription: 'Internal Server Error',
            headers: {
                'content-type': [{
                    key: 'Content-Type',
                    value: 'application/json'
                }]
            },
            body: JSON.stringify({ message: 'Internal Server Error: ' + err.message })
        };
    }
};
