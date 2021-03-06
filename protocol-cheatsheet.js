const protocol = {
    "frontend": {
        "Bind": 66,
        "Close": 67,
        "CopyData": 100,
        "CopyDone": 99,
        "CopyFail": 102,
        "Describe": 68,
        "Execute": 69,
        "Flush": 72,
        "FunctionCall": 70,
        "Parse": 80,
        "Query": 81,
        
        "SSLRequest": 83,

        "GSSResponse": 112,
        "PasswordMessage": 112,
        "SASLInitialResponse": 112,
        "SASLResponse": 112
    },
    "backend": {
        "AuthenticationOk": 82,
        "AuthenticationKerberosV5": 82,
        "AuthenticationCleartextPassword": 82,
        "AuthenticationMD5Password": 82,
        "AuthenticationSCMCredential": 82,
        "AuthenticationGSS": 82,
        "AuthenticationSSPI": 82,
        "AuthenticationGSSContinue": 82,
        "AuthenticationSASL": 82,
        "AuthenticationSASLContinue": 82,
        "AuthenticationSASLFinal": 82,
        
        "BackendKeyData": 75,
        "ParseComplete": 49,
        "BindComplete": 50,
        "CloseComplete": 51,
        "CommandComplete": 67,
        "RowDescription": 84,
        "DataRow": 68,
        "ErrorResponse": 69,
        "ParameterStatus": 83,
        "ReadyForQuery": 90,
        "PortalSuspended": 115,

        "CopyInResponse": 71,
        "CopyOutResponse": 72,
        "CopyBothResponse": 87,
        "CopyData": 100,
        "CopyDone": 99,
        "EmptyQueryResponse": 73,
        "FunctionCallResponse": 86,
        "NegotiateProtocolVersion": 118,
        "NoData": 110,
        "NoticeResponse": 78,
        "NotificationResponse": 65,
        "ParameterDescription": 116,
    }
}